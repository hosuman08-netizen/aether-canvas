/* Aether Canvas — 음성 레코더 / 편집기
 *
 * 설계 원칙
 *  - 도메인 정확도: 모든 수치는 실제 오디오 데이터에서 계산한다.
 *    레벨은 dBFS(0 = 풀스케일 클리핑), 스펙트로그램은 실제 FFT + Mel 축,
 *    파형은 실제 샘플의 min/max 포락선. 가짜 랜덤값 없음.
 *  - 비파괴: 편집(자르기)은 원본을 절대 덮어쓰지 않는다. 항상 새 녹음으로 저장.
 *  - 형식은 런타임 감지: MediaRecorder.isTypeSupported로 브라우저가 실제로
 *    쓸 수 있는 컨테이너를 고르고, 확장자는 실제 mimeType에서 파생한다.
 *  - 저장은 IndexedDB(blob) + persist() 승격. localStorage에는 메타만.
 */
'use strict';

/* ═══════════════════ 0. 상태 ═══════════════════ */

const META_KEY = 'aether_clips_v2';
const LEGACY_KEYS = ['aether_sessions', 'p6_sessions'];
const TRASH_DAYS = 30;

const S = {
  clips: [],            // 메타데이터 목록 (최신순)
  tab: 'record',
  liveView: 'wave',
  editView: 'wave',
  filter: 'all',
  search: '',
  fftSize: 2048,        // GOLD50 TOP5: 2k/4k. radix-2만. 가짜 해상도 카피 없음.
  titleOv: true         // WAVE88: 캔버스 제목 오버레이. 서버 STT 0.
};

// 녹음 상태
const R = {
  recording: false,
  mediaRecorder: null,
  stream: null,
  chunks: [],
  mime: '',
  startedAt: 0,
  raf: 0,
  peakDb: -Infinity,
  holdDb: -Infinity,
  holdAt: 0,
  clipped: false
};

// 편집 대상 클립
const E = {
  meta: null,           // 메타 레코드
  buffer: null,         // 디코딩된 AudioBuffer (편집 가능할 때만)
  blob: null,           // 원본 blob
  mip: null,            // {min:Float32Array,max:Float32Array,stride}
  t0: 0, t1: 1,         // 표시 구간 (초)
  sel: null,            // {a,b} 선택 구간 (초)
  markers: [],          // [{t, label, kind}] 구간 마커 (초, 오름차순)
  segments: [],         // 마지막 무음 감지가 찾은 말소리 구간 [{a,b}]
  dirty: false,         // 아직 라이브러리에 저장 안 됨
  specCache: null,      // {key, canvas}
  specTimer: 0,
  decodeFailed: false
};

// 재생 상태
const P = {
  src: null,
  playing: false,
  rate: 1,
  loop: false,
  loopLen: 0,           // WAVE81: 4|8|12 고정길이 루프. 0=구간선택
  offset: 0,            // 재생 시작 지점(초)
  startedAt: 0,         // audioCtx.currentTime 기준
  pos: 0,               // 정지 상태의 위치
  raf: 0
};

let audioCtx = null;

/* GOLD50 TOP2: 브라우저 Web Speech API 캡션.
   이 앱은 음성을 우리 서버로 보내지 않는다. Chrome 구현은 네트워크가 필요할 수 있음.
   오프라인·미지원·network 에러 = 실패 고지. 가짜 자막 없음. */
const Cap = { rec: null, final: '', interim: '' };

/* ═══════════════════ 1. 유틸 ═══════════════════ */

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);

function ctxGet() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!audioCtx || audioCtx.state === 'closed') audioCtx = new AC();
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

function fmtTime(sec, tenths) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const base = `${m}:${String(s).padStart(2, '0')}`;
  return tenths ? `${base}.${Math.floor((sec % 1) * 10)}` : base;
}

function fmtClock(sec) {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${Math.floor((sec % 1) * 10)}`;
}

function fmtBytes(n) {
  if (!n && n !== 0) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

// 진폭(0..1) → dBFS. 0 dBFS가 풀스케일 상한이라는 오디오 표준 그대로.
// -90 dBFS 아래는 16bit 양자화 잡음 수준이라 무음으로 본다 — 그렇게 하지 않으면
// 사실상 무음인 구간에서 -673 dBFS 같은 무의미한 숫자가 화면에 뜬다.
const DB_FLOOR = -90;
function toDb(amp) {
  if (!(amp > 0)) return -Infinity;
  const db = 20 * Math.log10(amp);
  return db < DB_FLOOR ? -Infinity : db;
}

function dbLabel(db) {
  if (!isFinite(db) || db <= DB_FLOOR) return '−∞';
  return (db > 0 ? '+' : '') + db.toFixed(1);
}

function fftSize() { return S.fftSize === 4096 ? 4096 : 2048; }

function applyFftSize(n) {
  const size = n === 4096 ? 4096 : 2048;
  S.fftSize = size;
  if (recAnalyser) {
    recAnalyser.fftSize = size;
    recTime = new Uint8Array(recAnalyser.fftSize);
    recFreq = new Uint8Array(recAnalyser.frequencyBinCount);
    recFloat = new Float32Array(recAnalyser.fftSize);
    liveSpecInit = false;
  }
  E.specCache = null;
  document.querySelectorAll('[data-fft]').forEach(x => {
    x.classList.toggle('is-active', Number(x.dataset.fft) === size);
  });
  if (S.editView === 'spec' && E.buffer) redrawEditor();
}

let toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}

function setStatus(msg) {
  const el = $('status');
  if (el) el.textContent = msg;
}

/* ═══════════════════ 2. 저장소 ═══════════════════ */
/* blob은 IndexedDB, 메타는 localStorage.
   IndexedDB 기본값은 best-effort라 디스크가 빠듯하면 조용히 지워질 수 있다.
   persist()로 영속 승격을 요청하고 estimate()로 잔여 용량을 보여준다. */

let _db = null;
function openDB() {
  return new Promise(resolve => {
    if (_db) return resolve(_db);
    if (!window.indexedDB) return resolve(null);
    try {
      const req = indexedDB.open('aether_audio', 1);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('clips')) db.createObjectStore('clips');
      };
      req.onsuccess = e => { _db = e.target.result; resolve(_db); };
      req.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
}

function putBlob(id, blob) {
  return openDB().then(db => new Promise(res => {
    if (!db) return res(false);
    try {
      const tx = db.transaction('clips', 'readwrite');
      tx.objectStore('clips').put(blob, String(id));
      tx.oncomplete = () => res(true);
      tx.onerror = () => res(false);
      tx.onabort = () => res(false);
    } catch (e) { res(false); }
  }));
}

function getBlob(id) {
  return openDB().then(db => new Promise(res => {
    if (!db) return res(null);
    try {
      const tx = db.transaction('clips', 'readonly');
      const r = tx.objectStore('clips').get(String(id));
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => res(null);
    } catch (e) { res(null); }
  }));
}

function delBlob(id) {
  return openDB().then(db => new Promise(res => {
    if (!db) return res(false);
    try {
      const tx = db.transaction('clips', 'readwrite');
      tx.objectStore('clips').delete(String(id));
      tx.oncomplete = () => res(true);
      tx.onerror = () => res(false);
    } catch (e) { res(false); }
  }));
}

function loadMeta() {
  let list = [];
  try { list = JSON.parse(localStorage.getItem(META_KEY) || '[]'); } catch (e) { list = []; }
  if (!Array.isArray(list)) list = [];

  // 예전 버전(노트북 세션)에서 넘어온 기록을 새 형식으로 흡수.
  if (!list.length) {
    for (const k of LEGACY_KEYS) {
      let old = [];
      try { old = JSON.parse(localStorage.getItem(k) || '[]'); } catch (e) { old = []; }
      if (Array.isArray(old) && old.length) {
        list = old.map(o => ({
          id: o.id || Date.now() + Math.floor(Math.random() * 1000),
          title: autoTitle(new Date(o.timestamp || Date.now()), o.duration || 0, null),
          createdAt: o.timestamp || new Date().toISOString(),
          duration: o.duration || 0,
          size: o.size || 0,
          mime: 'audio/webm',
          ext: 'webm',
          peaks: Array.isArray(o.voiceprint) ? o.voiceprint : null,
          note: (o.learnings || '').trim(),
          fav: false, deleted: false, deletedAt: null, derivedFrom: null,
          dbfsPeak: null, sampleRate: null, markers: []
        }));
        break;
      }
    }
  }
  S.clips = list;
  purgeOldTrash();
}


function aeDayKey(off){const d=new Date();d.setDate(d.getDate()+(off||0));return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function bumpAeStreak(kind){
  try{
    let st=JSON.parse(localStorage.getItem('ae_streak')||'{}');
    const t0=aeDayKey(0);
    if(st.last!==t0){
      const y=aeDayKey(-1),y2=aeDayKey(-2);
      if(st.last&&st.last!==y&&st.last===y2&&(st.count||0)>=3){
        const ready=!st.shieldLast||((new Date(t0)-new Date(st.shieldLast))/86400000)>=7;
        if(ready){st.shieldLast=t0;st.last=y;}
      }
      st.count=(st.last===y)?(st.count||0)+1:1; st.last=t0;
      localStorage.setItem('ae_streak',JSON.stringify(st));
      try{legionTrack('streak',{count:st.count})}catch(e){}
    }
    const k='ae_day_'+t0; let day=JSON.parse(localStorage.getItem(k)||'{"saves":0}');
    day.saves=(day.saves||0)+1; localStorage.setItem(k,JSON.stringify(day));
    renderAeLoop();
  }catch(e){}
}
function renderAeLoop(){
  try{
    let el=document.getElementById('aeLoop');
    if(!el){ el=document.createElement('div'); el.id='aeLoop';
      el.style.cssText='margin:8px 12px;padding:10px;border:1px solid #2a2438;border-radius:12px;font-size:12px;display:flex;flex-wrap:wrap;gap:8px;background:#12101a';
      const host=document.querySelector('header')||document.querySelector('h1')||document.body;
      host.insertAdjacentElement('afterend', el);
    }
    const st=JSON.parse(localStorage.getItem('ae_streak')||'{}');
    const day=JSON.parse(localStorage.getItem('ae_day_'+aeDayKey(0))||'{}');
    const end=new Date(); end.setHours(24,0,0,0);
    const ms=Math.max(0,end-Date.now());
    const clock=Math.floor(ms/3600000)+'h '+Math.floor((ms%3600000)/60000)+'m';
    el.innerHTML='🔥 '+(st.count||0)+'d · today saves '+(day.saves||0)+' · reset '+clock+' · <span style="opacity:.7">voice art · local only</span>';
  }catch(e){}
}

function saveMeta() {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(S.clips));
  } catch (e) {
    toast('저장 공간이 부족합니다. 휴지통을 비워보세요.');
  }
  updateLibCount();
}

function purgeOldTrash() {
  const cutoff = Date.now() - TRASH_DAYS * 864e5;
  const doomed = S.clips.filter(c => c.deleted && c.deletedAt && new Date(c.deletedAt).getTime() < cutoff);
  if (!doomed.length) return;
  doomed.forEach(c => delBlob(c.id));
  S.clips = S.clips.filter(c => doomed.indexOf(c) === -1);
}

async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      const already = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      if (!already) await navigator.storage.persist();
    }
  } catch (e) { /* 지원 안 하면 무시 — 기능에 영향 없음 */ }
}

async function storageLine() {
  const el = $('storage-line');
  if (!el) return;
  let persisted = false;
  try {
    if (navigator.storage && navigator.storage.persisted) persisted = await navigator.storage.persisted();
  } catch (e) {}
  let txt = '';
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      if (est && est.quota) {
        txt = `사용 ${fmtBytes(est.usage || 0)} / 여유 ${fmtBytes(Math.max(0, est.quota - (est.usage || 0)))}`;
      }
    }
  } catch (e) {}
  const badge = persisted
    ? '영구 저장 승인됨'
    : '기기 저장 공간이 부족하면 브라우저가 정리할 수 있습니다 — 중요한 녹음은 파일로 내보내세요';
  el.textContent = txt ? `${txt} • ${badge}` : badge;
}

/* ═══════════════════ 3. 형식 런타임 감지 ═══════════════════ */
/* 브라우저마다 쓰는 컨테이너가 다르다(Chrome/Firefox=webm/opus, Safari=mp4/aac).
   하드코딩하면 어떤 브라우저에서는 녹음이 아예 실패하거나, 더 나쁘게는
   내용은 Opus인데 파일명만 .wav가 되어 외부 도구가 거부한다.
   그래서 후보를 순서대로 물어보고, 저장할 때는 실제 mimeType으로 확장자를 만든다. */

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg'
];

function pickMime() {
  if (!window.MediaRecorder) return null;
  if (!MediaRecorder.isTypeSupported) return '';   // 구형: 브라우저 기본값에 맡김
  for (const m of MIME_CANDIDATES) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) {}
  }
  return '';
}

function extFor(mime) {
  const m = (mime || '').toLowerCase();
  if (m.indexOf('webm') >= 0) return 'webm';
  if (m.indexOf('mp4') >= 0 || m.indexOf('aac') >= 0) return 'm4a';
  if (m.indexOf('ogg') >= 0) return 'ogg';
  if (m.indexOf('wav') >= 0) return 'wav';
  return 'audio';
}

function describeFormat() {
  const note = $('fmt-note');
  if (!note) return;
  if (!window.MediaRecorder) {
    note.textContent = '이 브라우저는 녹음을 지원하지 않습니다.';
    return;
  }
  const m = pickMime();
  const label = m ? m.split(';')[0] : '브라우저 기본값';
  note.textContent = `녹음 형식: ${label} (.${extFor(m)}) — 이 브라우저가 실제로 지원하는 형식으로 저장됩니다. WAV가 필요하면 편집 화면에서 WAV로 내보내세요.`;
}

/* ═══════════════════ 4. WAV 인코딩 ═══════════════════ */
/* MediaRecorder는 webm/mp4만 내놓기 때문에, 진짜 .wav가 필요하면
   디코딩된 PCM 샘플에 직접 RIFF 헤더를 씌워야 한다. */

function wavAppendInam(ab, title) {
  title = String(title || '').trim().slice(0, 60);
  if (!title || !ab || ab.byteLength < 44) return ab;
  const enc = new TextEncoder().encode(title);
  const inamData = enc.length + 1;
  const inamPad = inamData & 1;
  const inamChunk = 8 + inamData + inamPad;
  const listSize = 4 + inamChunk;
  const extra = 8 + listSize;
  const out = new ArrayBuffer(ab.byteLength + extra);
  new Uint8Array(out).set(new Uint8Array(ab));
  const dv = new DataView(out);
  dv.setUint32(4, out.byteLength - 8, true);
  let o = ab.byteLength;
  const str = s => { for (let i = 0; i < s.length; i++) dv.setUint8(o++, s.charCodeAt(i)); };
  const u32 = v => { dv.setUint32(o, v, true); o += 4; };
  str('LIST'); u32(listSize); str('INFO');
  str('INAM'); u32(inamData);
  new Uint8Array(out).set(enc, o); o += enc.length;
  dv.setUint8(o++, 0);
  if (inamPad) dv.setUint8(o++, 0);
  return out;
}

function wavReadInam(ab) {
  if (!ab || ab.byteLength < 44) return '';
  const u8 = new Uint8Array(ab);
  const dv = new DataView(ab);
  const ascii = (o, n) => {
    let s = '';
    for (let i = 0; i < n && o + i < u8.length; i++) s += String.fromCharCode(u8[o + i]);
    return s;
  };
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') return '';
  let o = 12;
  while (o + 8 <= u8.length) {
    const id = ascii(o, 4);
    const sz = dv.getUint32(o + 4, true);
    if (id === 'LIST' && o + 12 <= u8.length && ascii(o + 8, 4) === 'INFO') {
      let p = o + 12;
      const end = Math.min(u8.length, o + 8 + sz);
      while (p + 8 <= end) {
        const cid = ascii(p, 4);
        const csz = dv.getUint32(p + 4, true);
        if (cid === 'INAM') {
          const lim = Math.min(csz, Math.max(0, end - (p + 8)));
          const bytes = u8.subarray(p + 8, p + 8 + lim);
          let n = bytes.length;
          while (n > 0 && bytes[n - 1] === 0) n--;
          try { return new TextDecoder().decode(bytes.subarray(0, n)); }
          catch (e) { return ''; }
        }
        p += 8 + csz + (csz & 1);
        if (csz < 0) break;
      }
    }
    o += 8 + sz + (sz & 1);
    if (sz < 0) break;
  }
  return '';
}

function wavInamCheckLine(read) {
  read = String(read || '').trim();
  if (!read) return 'WAV 제목 없음 · 서버 없음 · 탭해서 지우기';
  return 'WAV 제목 · ' + read.slice(0, 40) + ' · INAM 검수 · 탭해서 지우기';
}

function wavInamClearedLine() {
  return '지움 확인 · WAV 제목 검수 없음 · 서버 없음';
}

function wavInamClearedEmptyLine() {
  return 'WAV 제목 검수 없음 · 서버 없음';
}

const WAV_INAM_CLEARED_HIDE_MS = 3000;
let wavInamClearedHideTimer = 0;
let wavInamClearedHidden = false;

function wavInamClearedHideMs() {
  return WAV_INAM_CLEARED_HIDE_MS;
}

function hideWavInamCleared() {
  wavInamClearedHidden = true;
  wavInamClearedHideTimer = 0;
  const el = $('wavInamCleared');
  if (el) el.textContent = wavInamClearedEmptyLine();
  return true;
}

function armWavInamClearedHide() {
  if (wavInamClearedHideTimer) {
    clearTimeout(wavInamClearedHideTimer);
    wavInamClearedHideTimer = 0;
  }
  wavInamClearedHidden = false;
  wavInamClearedHideTimer = setTimeout(hideWavInamCleared, WAV_INAM_CLEARED_HIDE_MS);
}

function clearWavInamCheck() {
  const el = $('wavInamCheck');
  if (!el) {
    const gone = $('wavInamCleared');
    if (gone && !wavInamClearedHidden) return gone.textContent;
    return wavInamClearedHidden ? wavInamClearedEmptyLine() : wavInamClearedLine();
  }
  el.id = 'wavInamCleared';
  el.textContent = wavInamClearedLine();
  el.removeAttribute('role');
  el.title = '';
  el.style.cursor = 'default';
  el.onclick = null;
  armWavInamClearedHide();
  return el.textContent;
}

function paintWavInamCheck(read) {
  if (wavInamClearedHideTimer) {
    clearTimeout(wavInamClearedHideTimer);
    wavInamClearedHideTimer = 0;
  }
  wavInamClearedHidden = false;
  const line = wavInamCheckLine(read);
  let el = $('wavInamCheck') || $('wavInamCleared');
  if (!el) {
    el = document.createElement('p');
    el.className = 'sub';
    el.style.cssText = 'margin-top:6px;color:#67e8f9;font-size:12px;cursor:pointer';
    const act = document.querySelector('.actions');
    if (act && act.parentNode) act.parentNode.insertBefore(el, act.nextSibling);
    else return line;
  }
  el.id = 'wavInamCheck';
  el.textContent = line;
  el.setAttribute('role', 'button');
  el.title = '탭해서 지우기';
  el.style.cursor = 'pointer';
  el.onclick = clearWavInamCheck;
  return line;
}

function encodeWAV(buffer, startSec, endSec, title) {
  const sr = buffer.sampleRate;
  const ch = Math.min(2, buffer.numberOfChannels);
  const s0 = Math.max(0, Math.floor((startSec || 0) * sr));
  const s1 = Math.min(buffer.length, Math.floor((endSec == null ? buffer.duration : endSec) * sr));
  const n = Math.max(0, s1 - s0);

  const dataBytes = n * ch * 2;
  const ab = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(ab);
  let o = 0;
  const str = s => { for (let i = 0; i < s.length; i++) dv.setUint8(o++, s.charCodeAt(i)); };
  const u32 = v => { dv.setUint32(o, v, true); o += 4; };
  const u16 = v => { dv.setUint16(o, v, true); o += 2; };

  str('RIFF'); u32(36 + dataBytes); str('WAVE');
  str('fmt '); u32(16); u16(1); u16(ch); u32(sr);
  u32(sr * ch * 2); u16(ch * 2); u16(16);
  str('data'); u32(dataBytes);

  const chans = [];
  for (let c = 0; c < ch; c++) chans.push(buffer.getChannelData(c));
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      let v = chans[c][s0 + i] || 0;
      v = v < -1 ? -1 : (v > 1 ? 1 : v);
      dv.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7FFF, true);
      o += 2;
    }
  }
  return new Blob([wavAppendInam(ab, title)], { type: 'audio/wav' });
}

function sliceBuffer(buffer, startSec, endSec) {
  const ctx = ctxGet();
  const sr = buffer.sampleRate;
  const s0 = Math.max(0, Math.floor(startSec * sr));
  const s1 = Math.min(buffer.length, Math.floor(endSec * sr));
  const n = Math.max(1, s1 - s0);
  const out = ctx.createBuffer(buffer.numberOfChannels, n, sr);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    out.getChannelData(c).set(buffer.getChannelData(c).subarray(s0, s0 + n));
  }
  return out;
}

/* ═══════════════════ 5. FFT + Mel 스펙트로그램 ═══════════════════ */
/* 반복형 radix-2 FFT. 스펙트로그램의 주파수 축은 Mel 스케일로 매핑한다 —
   사람의 청감과 간격이 일치해서 같은 체감 음정 차이가 화면에서도 같은 간격이 된다. */

function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const a = ang * k, wr = Math.cos(a), wi = Math.sin(a);
        const ur = re[i + k], ui = im[i + k];
        const xr = re[i + k + half], xi = im[i + k + half];
        const vr = xr * wr - xi * wi;
        const vi = xr * wi + xi * wr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + half] = ur - vr; im[i + k + half] = ui - vi;
      }
    }
  }
}

const hzToMel = f => 2595 * Math.log10(1 + f / 700);
const melToHz = m => 700 * (Math.pow(10, m / 2595) - 1);

// dB(-90..0) → 앱의 금빛 팔레트. 어두운 배경에서 밝은 금색으로 올라간다.
function specColor(t) {
  t = clamp(t, 0, 1);
  const stops = [
    [10, 8, 6], [38, 28, 18], [93, 66, 34],
    [173, 132, 74], [225, 196, 138], [252, 244, 226]
  ];
  const x = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = stops[i], b = stops[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f)
  ];
}

// 지정 구간의 Mel 스펙트로그램을 오프스크린 캔버스에 그린다.
function computeSpectrogram(buffer, startSec, endSec, W, H) {
  const FFT = fftSize();                 // GOLD50: 2k=시간 / 4k=주파수. radix-2.
  const sr = buffer.sampleRate;
  const data = buffer.getChannelData(0);
  const s0 = Math.max(0, Math.floor(startSec * sr));
  const s1 = Math.min(data.length, Math.floor(endSec * sr));
  const span = Math.max(FFT, s1 - s0);
  const cols = W;
  const hop = Math.max(1, Math.floor((span - FFT) / Math.max(1, cols - 1)));

  const cnv = document.createElement('canvas');
  cnv.width = W; cnv.height = H;
  const c = cnv.getContext('2d');
  const img = c.createImageData(W, H);
  const px = img.data;

  const win = new Float32Array(FFT);
  for (let i = 0; i < FFT; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT - 1)); // Hann

  const re = new Float32Array(FFT), im = new Float32Array(FFT);
  const bins = FFT >> 1;
  const mag = new Float32Array(bins);

  const melMin = hzToMel(60), melMax = hzToMel(Math.min(sr / 2, 12000));
  const rowBin = new Int32Array(H);
  for (let y = 0; y < H; y++) {
    const mel = melMin + (melMax - melMin) * (1 - y / (H - 1)); // 위쪽이 고음
    const hz = melToHz(mel);
    rowBin[y] = clamp(Math.round(hz / (sr / 2) * (bins - 1)), 0, bins - 1);
  }

  for (let x = 0; x < cols; x++) {
    const off = s0 + x * hop;
    for (let i = 0; i < FFT; i++) {
      const s = off + i;
      re[i] = (s < s1 && s < data.length ? data[s] : 0) * win[i];
      im[i] = 0;
    }
    fftInPlace(re, im);
    for (let k = 0; k < bins; k++) {
      mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / (FFT / 4);
    }
    for (let y = 0; y < H; y++) {
      // 인접 빈을 조금 합쳐 저역의 계단현상을 줄인다.
      const b = rowBin[y];
      const b2 = y > 0 ? rowBin[y - 1] : b;
      let m = 0;
      const lo = Math.min(b, b2), hi = Math.max(b, b2);
      for (let k = lo; k <= hi; k++) { if (mag[k] > m) m = mag[k]; }
      const db = toDb(m);
      const t = isFinite(db) ? (db + 90) / 90 : 0;   // -90 dBFS를 바닥으로
      const rgb = specColor(t);
      const p = (y * W + x) * 4;
      px[p] = rgb[0]; px[p + 1] = rgb[1]; px[p + 2] = rgb[2]; px[p + 3] = 255;
    }
  }
  c.putImageData(img, 0, 0);
  return cnv;
}

/* ═══════════════════ 6. 파형 미프맵 ═══════════════════ */
/* 몇 분짜리 클립을 매 프레임 원본 샘플로 훑으면 재생 중 프레임이 떨어진다.
   256샘플 단위 min/max를 미리 만들어두고, 축소 상태에서는 그걸 그린다. */

const MIP_STRIDE = 256;
function buildMip(buffer) {
  const d = buffer.getChannelData(0);
  const n = Math.ceil(d.length / MIP_STRIDE);
  const mn = new Float32Array(n), mx = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = i * MIP_STRIDE, e = Math.min(d.length, s + MIP_STRIDE);
    let lo = 1, hi = -1;
    for (let k = s; k < e; k++) { const v = d[k]; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (lo > hi) { lo = 0; hi = 0; }
    mn[i] = lo; mx[i] = hi;
  }
  return { min: mn, max: mx, stride: MIP_STRIDE };
}

// 96포인트 실루엣 — 라이브러리 목록에서 각 녹음을 구분하는 지문.
function envelopeFromBuffer(buffer, n) {
  n = n || 96;
  const d = buffer.getChannelData(0);
  const step = Math.max(1, Math.floor(d.length / n));
  const out = [];
  let max = 0.0001;
  for (let i = 0; i < n; i++) {
    let peak = 0;
    const s = i * step, e = Math.min(d.length, s + step);
    for (let k = s; k < e; k++) { const a = Math.abs(d[k]); if (a > peak) peak = a; }
    if (peak > max) max = peak;
    out.push(peak);
  }
  return out.map(v => Math.round(v / max * 1000) / 1000);
}

function peakDbOf(buffer) {
  const d = buffer.getChannelData(0);
  let peak = 0;
  const stride = Math.max(1, Math.floor(d.length / 400000)); // 아주 긴 파일은 표본화
  for (let i = 0; i < d.length; i += stride) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
  return toDb(peak);
}

/* ═══════════════════ 6b. 무음 감지 (말소리 구간) ═══════════════════ */
/* 결정적 DSP. 20ms 프레임 RMS 포락선을 구하고, 잡음 바닥(하위 분위수)에서
   적응 임계값을 뽑은 뒤, 히스테리시스 상태기계로 말소리 구간을 나눈다.
   임계값을 하드코딩하지 않아 조용한 방/시끄러운 방 모두에 스스로 맞춘다.
   가짜·랜덤 없음 — 같은 오디오는 항상 같은 구간을 낸다. */
function detectSpeechSegments(buffer, opts) {
  opts = opts || {};
  const sr = buffer.sampleRate;
  const d = buffer.getChannelData(0);
  const dur = buffer.duration;
  const frame = Math.max(1, Math.round(sr * 0.02));   // 20ms 분석창
  const hop = Math.max(1, Math.round(sr * 0.01));     // 10ms 이동
  const nFrames = Math.max(1, Math.floor((d.length - frame) / hop) + 1);

  const rmsDb = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    const s = f * hop;
    let sum = 0;
    for (let i = 0; i < frame; i++) { const v = d[s + i] || 0; sum += v * v; }
    const rms = Math.sqrt(sum / frame);
    rmsDb[f] = rms > 0 ? 20 * Math.log10(rms) : -120;
  }

  // 적응 임계값: 잡음 바닥(하위 15% 분위수)보다 8 dB 위를 말소리로 본다.
  const sorted = Array.prototype.slice.call(rmsDb).sort((a, b) => a - b);
  const noiseFloor = sorted[Math.floor(sorted.length * 0.15)];
  const peak = sorted[sorted.length - 1];
  let thresh = clamp(noiseFloor + 8, -55, peak - 6);
  const empty = { segments: [], threshold: thresh, noiseFloor, peak, totalSilence: dur };
  // 신호와 잡음의 대비가 없으면(무음 파일 등) 나눌 것이 없다.
  if (!(peak - noiseFloor > 6) || !isFinite(peak)) return empty;

  const framesPerSec = sr / hop;
  const minSpeechF = Math.max(1, Math.round((opts.minSpeech != null ? opts.minSpeech : 0.18) * framesPerSec));
  const minSilenceF = Math.max(1, Math.round((opts.minSilence != null ? opts.minSilence : 0.30) * framesPerSec));

  const runs = [];
  let inSpeech = false, segStart = 0, silenceRun = 0;
  for (let f = 0; f < nFrames; f++) {
    const loud = rmsDb[f] >= thresh;
    if (!inSpeech) {
      if (loud) { inSpeech = true; segStart = f; silenceRun = 0; }
    } else if (loud) {
      silenceRun = 0;
    } else {
      silenceRun++;
      if (silenceRun >= minSilenceF) {
        const end = f - silenceRun + 1;
        if (end - segStart >= minSpeechF) runs.push([segStart, end]);
        inSpeech = false;
      }
    }
  }
  if (inSpeech && nFrames - segStart >= minSpeechF) runs.push([segStart, nFrames]);

  const fToSec = f => clamp(f * hop / sr, 0, dur);
  const segments = runs.map(r => ({ a: fToSec(r[0]), b: fToSec(Math.min(nFrames, r[1])) }));
  let voiced = 0;
  segments.forEach(s => { voiced += s.b - s.a; });
  return { segments, threshold: thresh, noiseFloor, peak, totalSilence: Math.max(0, dur - voiced) };
}

/* ═══════════════════ 6c. 구간 마커 ═══════════════════ */
/* 마커는 시간 위의 지점. 자동 감지가 말소리 시작마다 놓거나, M으로 직접 놓는다.
   [ ] 로 이웃 마커로 이동. 마커는 클립 메타에 함께 저장되어 다시 열어도 남는다. */

function sortMarkers() {
  E.markers.sort((m, n) => m.t - n.t);
}

function addMarker(t, label, kind) {
  if (!E.meta) return;
  const dur = E.meta.duration || 0;
  const time = clamp(t, 0, dur);
  // 같은 지점(50ms 이내) 중복 방지
  if (E.markers.some(m => Math.abs(m.t - time) < 0.05)) return;
  E.markers.push({ t: time, label: label || ('마커 ' + (E.markers.length + 1)), kind: kind || 'manual' });
  sortMarkers();
  persistMarkersIfSaved();
  updateMarkerUI();
  redrawEditor();
}

function clearMarkers() {
  E.markers = [];
  E.segments = [];
  persistMarkersIfSaved();
  updateMarkerUI();
  redrawEditor();
}

// 저장된(dirty 아님) 클립이면 마커 변경을 즉시 메타에 반영한다.
function persistMarkersIfSaved() {
  if (!E.meta) return;
  E.meta.markers = E.markers.map(m => ({ t: m.t, label: m.label, kind: m.kind }));
  if (!E.dirty) saveMeta();
}

function nearestMarkerIndex(t) {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < E.markers.length; i++) {
    const d = Math.abs(E.markers[i].t - t);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function gotoMarker(dir) {
  if (!E.meta || !E.markers.length) return;
  const now = currentPlayTime();
  let target = -1;
  if (dir > 0) {
    for (let i = 0; i < E.markers.length; i++) { if (E.markers[i].t > now + 0.01) { target = i; break; } }
    if (target < 0) target = E.markers.length - 1;
  } else {
    for (let i = E.markers.length - 1; i >= 0; i--) { if (E.markers[i].t < now - 0.01) { target = i; break; } }
    if (target < 0) target = 0;
  }
  const m = E.markers[target];
  P.pos = clamp(m.t, 0, E.meta.duration);
  // 마커가 화면 밖이면 그 지점이 보이도록 뷰를 따라 옮긴다.
  if (m.t < E.t0 || m.t > E.t1) {
    const span = viewSpan();
    setView(m.t - span * 0.35, m.t - span * 0.35 + span);
  }
  if (P.playing) playFrom(P.pos); else redrawEditor();
  setMarkerRead(m.label + ' · ' + (target + 1) + '/' + E.markers.length);
}

function setMarkerRead(txt) {
  const el = $('mk-read');
  if (el) el.textContent = txt;
}

function updateMarkerUI() {
  const has = E.markers.length > 0;
  const nav = $('mk-nav'), trim = $('mk-trim'), clr = $('mk-clear');
  if (nav) nav.classList.toggle('hidden', !has);
  if (clr) clr.classList.toggle('hidden', !has);
  if (trim) trim.classList.toggle('hidden', !E.segments.length);
  if (has) setMarkerRead(E.markers.length + '개 마커');
}

function runSilenceDetect() {
  if (!E.buffer) { toast('이 형식은 파형 분석을 할 수 없습니다.'); return; }
  const res = detectSpeechSegments(E.buffer);
  E.segments = res.segments;
  // 이전 자동 마커만 걷어내고(직접 놓은 마커는 보존) 새로 놓는다.
  E.markers = E.markers.filter(m => m.kind !== 'auto');
  res.segments.forEach((s, i) => {
    E.markers.push({ t: s.a, label: '구간 ' + (i + 1), kind: 'auto' });
  });
  sortMarkers();
  persistMarkersIfSaved();
  updateMarkerUI();
  redrawEditor();
  if (!res.segments.length) {
    toast('말소리 구간을 찾지 못했습니다 (거의 무음이거나 균일한 소리)');
  } else {
    const sil = res.totalSilence;
    toast(res.segments.length + '개 구간 감지 · 무음 ' + (sil >= 1 ? sil.toFixed(1) + '초' : Math.round(sil * 1000) + 'ms') +
          ' · 기준 ' + Math.round(res.threshold) + ' dBFS');
  }
}

// 앞뒤 무음을 뺀 말소리 전체 범위를 선택 구간으로 잡아준다(비파괴 — 자르기는 사용자가).
function trimSilenceSelect() {
  if (!E.buffer) return;
  if (!E.segments.length) {
    const res = detectSpeechSegments(E.buffer);
    E.segments = res.segments;
  }
  if (!E.segments.length) { toast('다듬을 말소리 구간을 찾지 못했습니다.'); return; }
  const pad = 0.06;
  const a = clamp(E.segments[0].a - pad, 0, E.buffer.duration);
  const b = clamp(E.segments[E.segments.length - 1].b + pad, 0, E.buffer.duration);
  setSel(a, b);
  const cut = E.buffer.duration - (b - a);
  toast('앞뒤 무음 ' + (cut >= 0.1 ? cut.toFixed(1) + '초' : Math.round(cut * 1000) + 'ms') +
        ' 제외 — "선택 구간만 새 녹음으로"로 저장하세요');
}

/* ═══════════════════ 7. 레벨 미터 (dBFS) ═══════════════════ */

function drawMeter(db, holdDb, clipped) {
  const cnv = $('meter');
  if (!cnv) return;
  const c = cnv.getContext('2d');
  const W = cnv.width, H = cnv.height;
  const barY = 4, barH = H - 16;
  const MIN = -60;

  const pos = v => clamp((v - MIN) / (0 - MIN), 0, 1) * W;

  c.clearRect(0, 0, W, H);
  // 신호가 없을 때도 "미터"로 읽히도록 트랙 자체를 보이게 그린다
  c.fillStyle = '#13100b';
  c.fillRect(0, barY, W, barH);
  // 위험 구역(-3 dBFS 위)을 미리 표시해 어디가 한계인지 보이게 한다
  c.fillStyle = 'rgba(216,80,60,0.12)';
  c.fillRect(pos(-3), barY, W - pos(-3), barH);
  c.strokeStyle = 'rgba(197,164,110,0.28)';
  c.lineWidth = 1;
  c.strokeRect(0.5, barY + 0.5, W - 1, barH - 1);

  // 레벨 바 — 여유 구간은 금색, 0 dBFS에 가까울수록 경고색
  const w = pos(db);
  if (w > 0) {
    const grad = c.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, '#6b5836');
    grad.addColorStop(clamp(pos(-18) / W, 0, 1), '#c5a46e');
    grad.addColorStop(clamp(pos(-6) / W, 0, 1), '#e0c48a');
    grad.addColorStop(clamp(pos(-3) / W, 0, 1), '#e8a24a');
    grad.addColorStop(1, '#d8503c');
    c.fillStyle = grad;
    c.fillRect(0, barY, w, barH);
  }

  // 피크 홀드 — 짧은 트랜지언트를 눈으로 잡을 수 있게 잠깐 머문다
  if (isFinite(holdDb)) {
    c.fillStyle = holdDb > -1 ? '#ff6b52' : '#f5e6c3';
    c.fillRect(clamp(pos(holdDb) - 1.5, 0, W - 2), barY, 2, barH);
  }

  // 눈금 — 오디오 앱의 공통 기준선
  c.font = '9px system-ui, sans-serif';
  c.textAlign = 'center';
  [-48, -36, -24, -18, -12, -6, -3, 0].forEach(v => {
    const x = pos(v);
    const major = (v === -6 || v === -3 || v === 0);
    c.fillStyle = major ? 'rgba(245,230,195,0.55)' : 'rgba(197,164,110,0.25)';
    c.fillRect(clamp(x - 0.5, 0, W - 1), barY, 1, major ? barH : barH * 0.4);
    if (major || v === -24 || v === -48) {
      c.fillStyle = 'rgba(163,138,102,0.8)';
      c.fillText(String(v), clamp(x, 10, W - 10), H - 2);
    }
  });

  const flag = $('clip-flag');
  if (flag) flag.classList.toggle('hidden', !clipped);
  const read = $('meter-db');
  if (read) read.textContent = dbLabel(db);
  const holdEl = $('meter-hold');
  if (holdEl) holdEl.textContent = 'HOLD ' + dbLabel(holdDb);
}

function resetMeter() {
  R.peakDb = -Infinity; R.holdDb = -Infinity; R.clipped = false;
  drawMeter(-Infinity, -Infinity, false);
}

/* ═══════════════════ 8. 라이브 시각화 ═══════════════════ */

let liveSpecInit = false;

function liveCtx() {
  const cnv = $('live-canvas');
  return cnv ? cnv.getContext('2d') : null;
}

function clearLive() {
  const cnv = $('live-canvas');
  const c = liveCtx();
  if (!c || !cnv) return;
  c.fillStyle = '#0a0806';
  c.fillRect(0, 0, cnv.width, cnv.height);
  liveSpecInit = false;
}

function drawLiveIdle() {
  const cnv = $('live-canvas');
  const c = liveCtx();
  if (!c || !cnv) return;
  c.fillStyle = '#0a0806';
  c.fillRect(0, 0, cnv.width, cnv.height);
  const cy = cnv.height / 2;
  for (let i = 0; i < 5; i++) {
    c.fillStyle = `rgba(197,164,110,${0.02 + i * 0.008})`;
    c.beginPath();
    c.ellipse(cnv.width / 2 + (i - 2) * 60, cy, 360 - i * 34, 74 - i * 8, 0, 0, Math.PI * 2);
    c.fill();
  }
  c.strokeStyle = 'rgba(197,164,110,0.18)';
  c.lineWidth = 1;
  c.beginPath(); c.moveTo(0, cy); c.lineTo(cnv.width, cy); c.stroke();
}

// 실제 시간영역 샘플을 그대로 그리는 오실로스코프 + 부드러운 겹침 레이어.
function drawLiveWave(timeData, amp) {
  const cnv = $('live-canvas');
  const c = liveCtx();
  if (!c || !cnv) return;
  const W = cnv.width, H = cnv.height, cy = H / 2;

  c.fillStyle = 'rgba(10,8,6,0.34)';
  c.fillRect(0, 0, W, H);

  // 부드러운 배경 글레이즈 — 실제 신호에만 반응하는 은은한 층
  for (let l = 0; l < 5; l++) {
    c.strokeStyle = `hsla(${38 + l * 3}, 44%, 68%, ${0.055 - l * 0.008})`;
    c.lineWidth = 2.4 + l * 0.5;
    c.beginPath();
    const off = (l - 2) * 7;
    for (let x = 0; x <= W; x += 6) {
      const idx = Math.min(timeData.length - 1, Math.floor(x / W * timeData.length));
      const v = (timeData[idx] - 128) / 128;
      const y = cy + off + v * cy * (0.55 + l * 0.12);
      if (x === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.stroke();
  }

  // 주인공 선: 진짜 파형
  c.save();
  c.shadowBlur = 14;
  c.shadowColor = 'rgba(242,225,188,0.5)';
  c.strokeStyle = `rgba(245,230,195,${0.55 + Math.min(0.4, amp * 0.6)})`;
  c.lineWidth = 1.8;
  c.beginPath();
  const step = timeData.length / W;
  for (let x = 0; x < W; x++) {
    const v = (timeData[Math.floor(x * step)] - 128) / 128;
    const y = cy + v * cy * 0.92;
    if (x === 0) c.moveTo(x, y); else c.lineTo(x, y);
  }
  c.stroke();
  c.restore();

  if (window.drawGoldenDetail) {
    window.drawGoldenDetail(c, W, cy, { phase: (Date.now() % 6280) / 1000 }, amp);
  }
}

// 라이브 스펙트로그램: 기존 픽셀을 왼쪽으로 밀고 오른쪽에 새 세로줄을 그린다.
// 주파수 눈금은 스크롤되지 않는 좌측 고정 영역에 그린다 — 스크롤 영역 안에
// 글자를 그리면 매 프레임 함께 밀려서 잔상이 길게 번진다.
const SPEC_GUTTER = 46;
function drawLiveSpec(freqData, sampleRate) {
  const cnv = $('live-canvas');
  const c = liveCtx();
  if (!c || !cnv) return;
  const W = cnv.width, H = cnv.height;
  const SHIFT = 3;
  const x0 = SPEC_GUTTER;

  if (!liveSpecInit) {
    c.fillStyle = '#0a0806';
    c.fillRect(0, 0, W, H);
    liveSpecInit = true;
  }

  // 데이터 영역만 왼쪽으로 이동
  const img = c.getImageData(x0 + SHIFT, 0, W - x0 - SHIFT, H);
  c.putImageData(img, x0, 0);

  const bins = freqData.length;
  const nyq = sampleRate / 2;
  const top = Math.min(nyq, 12000);
  const melMin = hzToMel(60), melMax = hzToMel(top);
  for (let y = 0; y < H; y++) {
    const hz = melToHz(melMin + (melMax - melMin) * (1 - y / (H - 1)));
    const b = clamp(Math.round(hz / nyq * (bins - 1)), 0, bins - 1);
    const v = freqData[b] / 255;                 // getByteFrequencyData는 이미 dB 정규화
    const rgb = specColor(v);
    c.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    c.fillRect(W - SHIFT, y, SHIFT, 1);
  }

  // 고정 주파수 축 (Mel 위치에 맞춘 실제 Hz)
  c.fillStyle = '#0a0806';
  c.fillRect(0, 0, x0, H);
  c.font = '9px system-ui, sans-serif';
  c.textAlign = 'right';
  c.textBaseline = 'middle';
  [200, 500, 1000, 2000, 5000, 10000].forEach(hz => {
    if (hz > top) return;
    const y = (1 - (hzToMel(hz) - melMin) / (melMax - melMin)) * (H - 1);
    c.fillStyle = 'rgba(245,230,195,0.42)';
    c.fillText(hz >= 1000 ? (hz / 1000) + 'k' : String(hz), x0 - 9, clamp(y, 6, H - 6));
    c.fillRect(x0 - 5, y, 4, 1);
  });
  c.textBaseline = 'alphabetic';
  c.fillStyle = 'rgba(139,115,85,0.6)';
  c.textAlign = 'left';
  c.fillText('Hz', 4, 12);
}

/* ═══════════════════ 8b. 로컬 캡션 (Web Speech API · 서버 STT 없음) ═══════════════════ */

function speechCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function setCaptionNote(msg, isFail) {
  const el = $('caption-note');
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('is-fail', !!isFail);
}

function setCaptionText(t) {
  const el = $('live-caption');
  if (el) el.textContent = t || '';
}

function captionSnapshot() {
  return ((Cap.final || '') + ' ' + (Cap.interim || '')).replace(/\s+/g, ' ').trim();
}

function stopCaption() {
  const rec = Cap.rec;
  Cap.rec = null;
  if (rec) {
    try { rec.onend = null; rec.onerror = null; rec.onresult = null; } catch (e) {}
    try { rec.stop(); } catch (e) {}
    try { rec.abort(); } catch (e) {}
  }
}

function startCaption() {
  stopCaption();
  Cap.final = '';
  Cap.interim = '';
  setCaptionText('');

  const want = $('opt-caption') ? $('opt-caption').checked : true;
  if (!want) {
    setCaptionNote('캡션 끔 · 서버 STT 없음');
    return;
  }

  const Ctor = speechCtor();
  if (!Ctor) {
    setCaptionNote('이 브라우저는 Web Speech API가 없습니다. 서버 STT 없음 · 캡션 불가.', true);
    return;
  }
  if (typeof navigator.onLine !== 'undefined' && navigator.onLine === false) {
    setCaptionNote('오프라인 — 캡션 실패. 이 앱은 서버 STT를 쓰지 않습니다.', true);
    return;
  }

  try {
    const rec = new Ctor();
    rec.lang = document.documentElement.lang || 'ko-KR';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = function (ev) {
      let fin = '';
      let inter = '';
      for (let i = 0; i < ev.results.length; i++) {
        const r = ev.results[i];
        const t = (r[0] && r[0].transcript) || '';
        if (r.isFinal) fin += (fin ? ' ' : '') + t.trim();
        else inter += t;
      }
      Cap.final = fin.trim();
      Cap.interim = inter.trim();
      setCaptionText(captionSnapshot());
    };
    rec.onerror = function (ev) {
      const err = (ev && ev.error) || '';
      if (err === 'no-speech' || err === 'aborted') return;
      if (err === 'network' || err === 'service-not-allowed') {
        setCaptionNote('캡션 실패 (네트워크/오프라인). 서버 STT 없음. 이 앱은 음성을 우리 서버로 보내지 않습니다.', true);
        stopCaption();
        return;
      }
      if (err === 'not-allowed') {
        setCaptionNote('캡션 권한 거부. 서버 STT 없음.', true);
        return;
      }
      setCaptionNote('캡션 실패: ' + err + ' · 서버 STT 없음.', true);
    };
    rec.onend = function () {
      if (R.recording && Cap.rec === rec) {
        try { rec.start(); } catch (e) {}
      }
    };
    rec.start();
    Cap.rec = rec;
    setCaptionNote('브라우저 Web Speech · 서버 STT 없음. Chrome은 네트워크가 필요할 수 있음. 오프라인이면 실패.');
  } catch (e) {
    setCaptionNote('캡션을 시작하지 못했습니다. 서버 STT 없음.', true);
  }
}

/* ═══════════════════ 9. 녹음 ═══════════════════ */

let recAnalyser = null, recTime = null, recFreq = null, recFloat = null;

async function startRecording() {
  if (R.recording) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus('이 브라우저는 마이크 입력을 지원하지 않습니다.');
    return;
  }
  if (!window.MediaRecorder) {
    setStatus('이 브라우저는 녹음을 지원하지 않습니다.');
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: $('opt-ec') ? $('opt-ec').checked : true,
        noiseSuppression: $('opt-ns') ? $('opt-ns').checked : true,
        autoGainControl: $('opt-agc') ? $('opt-agc').checked : false
      }
    });
    R.stream = stream;

    const mime = pickMime();
    let rec;
    try {
      rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch (e) {
      rec = new MediaRecorder(stream);   // 지정 형식 거부 시 브라우저 기본값으로 후퇴
    }
    R.mediaRecorder = rec;
    R.mime = rec.mimeType || mime || 'audio/webm';
    R.chunks = [];

    rec.ondataavailable = e => { if (e.data && e.data.size) R.chunks.push(e.data); };
    rec.onstop = () => finishRecording();

    // 분석 체인 — 미터와 시각화 모두 이 실제 신호에서 나온다
    const ctx = ctxGet();
    if (ctx) {
      const src = ctx.createMediaStreamSource(stream);
      recAnalyser = ctx.createAnalyser();
      recAnalyser.fftSize = fftSize();          // 2k/4k 토글. 창=Hann은 스펙 계산과 동일.
      recAnalyser.smoothingTimeConstant = 0.6;
      recAnalyser.minDecibels = -90;
      recAnalyser.maxDecibels = -10;
      src.connect(recAnalyser);
      recTime = new Uint8Array(recAnalyser.fftSize);
      recFreq = new Uint8Array(recAnalyser.frequencyBinCount);
      recFloat = new Float32Array(recAnalyser.fftSize);
    }

    rec.start(250);
    R.recording = true;
    R.startedAt = Date.now();
    resetMeter();
    liveSpecInit = false;
    clearLive();

    $('rec-btn').disabled = true;
    $('rec-btn').textContent = '● 녹음 중';
    $('rec-btn').setAttribute('aria-label', '녹음 중');
    $('rec-btn').classList.add('is-live');
    $('stop-btn').disabled = false;
    const hint = $('live-hint'); if (hint) hint.classList.add('hidden');
    setStatus('녹음 중 · 정지 또는 스페이스');

    liveLoop();
    startCaption();
  } catch (err) {
    setStatus('마이크 권한이 필요합니다. 브라우저 주소창의 권한 설정을 확인하세요.');
  }
}

function liveLoop() {
  if (!R.recording) return;

  if (recAnalyser) {
    recAnalyser.getByteTimeDomainData(recTime);

    // 진짜 피크 진폭 → dBFS. Float 데이터가 있으면 그쪽이 정확하다.
    let peak = 0;
    if (recAnalyser.getFloatTimeDomainData) {
      recAnalyser.getFloatTimeDomainData(recFloat);
      for (let i = 0; i < recFloat.length; i++) { const a = Math.abs(recFloat[i]); if (a > peak) peak = a; }
    } else {
      for (let i = 0; i < recTime.length; i++) {
        const a = Math.abs((recTime[i] - 128) / 128);
        if (a > peak) peak = a;
      }
    }
    const db = toDb(peak);
    if (peak >= 0.99) R.clipped = true;

    const now = performance.now();
    if (db > R.holdDb || now - R.holdAt > 1200) { R.holdDb = db; R.holdAt = now; }
    if (db > R.peakDb) R.peakDb = db;
    drawMeter(db, R.holdDb, R.clipped);

    if (S.liveView === 'spec') {
      recAnalyser.getByteFrequencyData(recFreq);
      drawLiveSpec(recFreq, (audioCtx && audioCtx.sampleRate) || 48000);
    } else {
      drawLiveWave(recTime, peak);
    }
  }

  const el = (Date.now() - R.startedAt) / 1000;
  const t = $('rec-time');
  if (t) t.textContent = fmtClock(el);

  R.raf = requestAnimationFrame(liveLoop);
}

function stopRecording() {
  if (!R.recording || !R.mediaRecorder) return;
  R.recording = false;
  cancelAnimationFrame(R.raf);
  stopCaption();
  try { R.mediaRecorder.stop(); } catch (e) {}
  $('rec-btn').disabled = false;
  $('rec-btn').textContent = '● 녹음';
  $('rec-btn').setAttribute('aria-label', '녹음 시작');
  $('rec-btn').classList.remove('is-live');
  $('stop-btn').disabled = true;
  setStatus('처리 중…');
}

async function finishRecording() {
  const blob = new Blob(R.chunks, { type: R.mime });
  if (R.stream) { R.stream.getTracks().forEach(t => t.stop()); R.stream = null; }
  recAnalyser = null;

  if (!blob.size) {
    setStatus('녹음된 소리가 없습니다. 마이크 입력을 확인해 주세요.');
    return;
  }

  const meta = {
    id: Date.now(),
    title: '',
    createdAt: new Date().toISOString(),
    duration: (Date.now() - R.startedAt) / 1000,
    size: blob.size,
    mime: R.mime,
    ext: extFor(R.mime),
    peaks: null,
    note: '',
    fav: false, deleted: false, deletedAt: null,
    derivedFrom: null,
    dbfsPeak: isFinite(R.peakDb) ? Math.round(R.peakDb * 10) / 10 : null,
    sampleRate: null,
    markers: [],
    caption: captionSnapshot()
  };

  await openClip(meta, blob, true);
  setStatus('녹음 완료 — 편집 화면에서 다듬고 저장하세요.');
  toast('녹음 완료');
}

/* ═══════════════════ 10. 클립 열기 / 디코딩 ═══════════════════ */

async function openClip(meta, blob, isNew) {
  stopPlayback();
  E.meta = meta;
  E.blob = blob;
  E.buffer = null;
  E.mip = null;
  E.sel = null;
  E.specCache = null;
  E.decodeFailed = false;
  E.dirty = !!isNew;
  // 저장돼 있던 마커를 되살리고, 감지 결과는 새로 계산하도록 비운다.
  E.markers = Array.isArray(meta.markers) ? meta.markers.map(m => ({ t: m.t, label: m.label, kind: m.kind })) : [];
  E.segments = [];

  switchTab('edit');
  $('edit-empty').classList.add('hidden');
  $('edit-body').classList.remove('hidden');
  $('spec-busy').classList.add('hidden');

  const ctx = ctxGet();
  try {
    const ab = await blob.arrayBuffer();
    E.buffer = await new Promise((res, rej) => {
      // 콜백 형태로도 함께 부르면 구형 Safari까지 커버된다.
      const p = ctx.decodeAudioData(ab, res, rej);
      if (p && p.then) p.then(res, rej);
    });
  } catch (e) {
    E.decodeFailed = true;
  }

  if (E.buffer) {
    E.mip = buildMip(E.buffer);
    meta.duration = E.buffer.duration;
    meta.sampleRate = E.buffer.sampleRate;
    if (!meta.peaks) meta.peaks = envelopeFromBuffer(E.buffer);
    if (meta.dbfsPeak == null) meta.dbfsPeak = Math.round(peakDbOf(E.buffer) * 10) / 10;
    E.t0 = 0; E.t1 = E.buffer.duration;
  } else {
    E.t0 = 0; E.t1 = Math.max(1, meta.duration || 1);
  }

  if (!meta.title) meta.title = autoTitle(new Date(meta.createdAt), meta.duration, meta.dbfsPeak);

  $('clip-title').value = meta.title;
  P.pos = 0;
  renderClipMeta();
  drawMinimap();
  redrawEditor();
  updateSelReadout();
  updateMarkerUI();
}

// 목록에서 바로 구분되는 자동 제목. "무제목 1/2/3"은 3개만 쌓여도 무너진다.
function autoTitle(date, dur, dbfs) {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  let tone = '';
  if (dbfs != null && isFinite(dbfs)) {
    tone = dbfs > -6 ? ' 또렷한' : (dbfs > -18 ? ' 편안한' : ' 조용한');
  }
  const len = dur >= 60 ? `${Math.round(dur / 60)}분` : `${Math.max(1, Math.round(dur))}초`;
  return `${mm}/${dd} ${hh}:${mi}${tone} ${len}`;
}

function renderClipMeta() {
  const el = $('clip-meta');
  if (!el || !E.meta) return;
  const m = E.meta;
  const bits = [
    fmtTime(m.duration, true),
    fmtBytes(m.size),
    (m.mime || '').split(';')[0].replace('audio/', '') || '—'
  ];
  if (m.sampleRate) bits.push((m.sampleRate / 1000).toFixed(1) + ' kHz');
  if (m.dbfsPeak != null && isFinite(m.dbfsPeak)) bits.push('피크 ' + dbLabel(m.dbfsPeak) + ' dBFS');
  if (m.derivedFrom) bits.push('편집본');
  el.textContent = bits.join(' • ');

  const capEl = $('clip-caption');
  if (capEl) {
    const cap = (m.caption || '').trim();
    capEl.textContent = cap ? cap : '';
    capEl.classList.toggle('hidden', !cap);
  }

  const dur = $('dur-read');
  if (dur) dur.textContent = fmtTime(m.duration, true);

  if (E.decodeFailed) {
    const busy = $('spec-busy');
    busy.classList.remove('hidden');
    busy.textContent = '이 브라우저에서는 이 형식을 열어볼 수 없습니다. 재생과 원본 내보내기는 가능합니다.';
  }
}

/* ═══════════════════ 11. 편집 캔버스 ═══════════════════ */

function viewSpan() { return Math.max(0.01, E.t1 - E.t0); }
function timeToX(t, W) { return (t - E.t0) / viewSpan() * W; }
function xToTime(x, W) { return E.t0 + (x / W) * viewSpan(); }

function drawRuler() {
  const cnv = $('ruler');
  if (!cnv) return;
  const c = cnv.getContext('2d');
  const W = cnv.width, H = cnv.height;
  c.fillStyle = '#0e0b08';
  c.fillRect(0, 0, W, H);

  const span = viewSpan();
  const pxPerSec = W / span;
  // 눈금 간격을 화면 밀도에 맞춰 고른다 (Audacity/Audition 관행)
  const steps = [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  let step = steps[steps.length - 1];
  for (const s of steps) { if (s * pxPerSec >= 68) { step = s; break; } }

  c.font = '10px system-ui, sans-serif';
  c.textAlign = 'left';
  const start = Math.floor(E.t0 / step) * step;
  for (let t = start; t <= E.t1 + step; t += step) {
    if (t < 0) continue;
    const x = timeToX(t, W);
    if (x < -40 || x > W + 40) continue;
    c.fillStyle = 'rgba(197,164,110,0.4)';
    c.fillRect(Math.round(x), H - 8, 1, 8);
    c.fillStyle = 'rgba(163,138,102,0.85)';
    const label = step < 1 ? t.toFixed(2) + 's' : fmtTime(t, false);
    c.fillText(label, Math.round(x) + 3, 11);
  }
  // 잔 눈금
  const minor = step / 5;
  if (minor * pxPerSec > 6) {
    c.fillStyle = 'rgba(197,164,110,0.16)';
    for (let t = start; t <= E.t1 + step; t += minor) {
      const x = timeToX(t, W);
      if (x < 0 || x > W) continue;
      c.fillRect(Math.round(x), H - 4, 1, 4);
    }
  }

  // 마커 위치를 눈금 위에 삼각 표식으로 겹쳐 보여준다
  if (E.markers.length) {
    E.markers.forEach(m => {
      const x = timeToX(m.t, W);
      if (x < -1 || x > W + 1) return;
      c.fillStyle = m.kind === 'auto' ? '#8a733a' : '#c5a46e';
      c.beginPath();
      c.moveTo(x - 3, 0); c.lineTo(x + 3, 0); c.lineTo(x, 5); c.closePath();
      c.fill();
    });
  }
}

function drawWaveInto(c, W, H) {
  const buf = E.buffer;
  c.fillStyle = '#0a0806';
  c.fillRect(0, 0, W, H);
  if (!buf) {
    c.fillStyle = 'rgba(163,138,102,0.6)';
    c.font = '13px system-ui, sans-serif';
    c.textAlign = 'center';
    c.fillText('이 형식은 파형으로 표시할 수 없습니다', W / 2, H / 2);
    return;
  }

  const sr = buf.sampleRate;
  const d = buf.getChannelData(0);
  const cy = H / 2;
  const s0 = E.t0 * sr, s1 = E.t1 * sr;
  const spp = (s1 - s0) / W;            // 픽셀당 샘플 수

  c.strokeStyle = 'rgba(197,164,110,0.14)';
  c.lineWidth = 1;
  c.beginPath(); c.moveTo(0, cy); c.lineTo(W, cy); c.stroke();

  c.fillStyle = 'rgba(225,196,138,0.9)';
  if (spp >= MIP_STRIDE && E.mip) {
    const mip = E.mip;
    for (let x = 0; x < W; x++) {
      const a = Math.floor((s0 + x * spp) / mip.stride);
      const b = Math.max(a + 1, Math.floor((s0 + (x + 1) * spp) / mip.stride));
      let lo = 1, hi = -1;
      for (let i = a; i < b && i < mip.min.length; i++) {
        if (mip.min[i] < lo) lo = mip.min[i];
        if (mip.max[i] > hi) hi = mip.max[i];
      }
      if (lo > hi) { lo = 0; hi = 0; }
      const y0 = cy - hi * cy * 0.94, y1 = cy - lo * cy * 0.94;
      c.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  } else {
    for (let x = 0; x < W; x++) {
      const a = Math.floor(s0 + x * spp), b = Math.max(a + 1, Math.floor(s0 + (x + 1) * spp));
      let lo = 1, hi = -1;
      for (let i = a; i < b && i < d.length; i++) { const v = d[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      if (lo > hi) { lo = 0; hi = 0; }
      const y0 = cy - hi * cy * 0.94, y1 = cy - lo * cy * 0.94;
      c.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
    // 아주 확대했을 땐 샘플을 잇는 선이 더 읽기 쉽다
    if (spp < 1) {
      c.strokeStyle = 'rgba(245,230,195,0.85)';
      c.lineWidth = 1.2;
      c.beginPath();
      for (let x = 0; x < W; x++) {
        const i = Math.floor(s0 + x * spp);
        const v = d[i] || 0;
        const y = cy - v * cy * 0.94;
        if (x === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
      c.stroke();
    }
  }
}

function specKey() {
  return `${E.meta ? E.meta.id : 0}|${E.t0.toFixed(3)}|${E.t1.toFixed(3)}|${fftSize()}`;
}

function ensureSpectrogram() {
  if (!E.buffer) return null;
  const key = specKey();
  if (E.specCache && E.specCache.key === key) return E.specCache.canvas;
  // 계산이 무거우므로 뷰가 멈춘 뒤에 한 번만 돌린다
  clearTimeout(E.specTimer);
  const busy = $('spec-busy');
  busy.classList.remove('hidden');
  busy.textContent = '주파수 분석 중…';
  E.specTimer = setTimeout(() => {
    const cnv = $('edit-canvas');
    const wanted = specKey();
    const img = computeSpectrogram(E.buffer, E.t0, E.t1, Math.min(700, cnv.width), cnv.height);
    E.specCache = { key: wanted, canvas: img };
    busy.classList.add('hidden');
    redrawEditor();
  }, 90);
  return E.specCache ? E.specCache.canvas : null;
}

function drawEditOverlay(c, W, H) {
  // 구간 마커 — 얇은 세로선 + 위쪽 번호 깃발. 화면 밖은 건너뛴다.
  if (E.markers.length) {
    c.font = '9px system-ui, sans-serif';
    c.textAlign = 'left';
    c.textBaseline = 'alphabetic';
    E.markers.forEach((m, i) => {
      const x = timeToX(m.t, W);
      if (x < -1 || x > W + 1) return;
      const auto = m.kind === 'auto';
      c.fillStyle = auto ? 'rgba(197,164,110,0.4)' : 'rgba(224,196,138,0.55)';
      c.fillRect(Math.round(x), 12, 1, H - 12);
      // 깃발
      c.fillStyle = auto ? '#8a733a' : '#c5a46e';
      c.fillRect(Math.round(x), 0, 15, 12);
      c.fillStyle = '#0a0806';
      c.fillText(String(i + 1), Math.round(x) + 3, 9);
    });
  }

  // 선택 구간
  if (E.sel) {
    const xa = timeToX(Math.min(E.sel.a, E.sel.b), W);
    const xb = timeToX(Math.max(E.sel.a, E.sel.b), W);
    c.fillStyle = 'rgba(197,164,110,0.16)';
    c.fillRect(xa, 0, xb - xa, H);
    c.fillStyle = '#c5a46e';
    c.fillRect(xa - 1, 0, 2, H);
    c.fillRect(xb - 1, 0, 2, H);
    // 잡기 쉬운 핸들 (거친 드래그 / 미세 조정 2단)
    [xa, xb].forEach(x => {
      c.fillStyle = '#e0c48a';
      c.fillRect(x - 4, H / 2 - 14, 8, 28);
      c.fillStyle = '#0a0806';
      c.fillRect(x - 1, H / 2 - 8, 1, 16);
      c.fillRect(x + 1, H / 2 - 8, 1, 16);
    });
  }

  // 플레이헤드
  const pos = currentPlayTime();
  const px = timeToX(pos, W);
  if (px >= -2 && px <= W + 2) {
    c.fillStyle = 'rgba(255,255,255,0.92)';
    c.fillRect(Math.round(px), 0, 1.5, H);
    c.fillStyle = '#f5e6c3';
    c.beginPath();
    c.moveTo(px - 6, 0); c.lineTo(px + 6, 0); c.lineTo(px, 9); c.closePath();
    c.fill();
  }

  // WAVE88: 제목 오버레이. 클립 제목만. 서버 STT 0. lung 원본.
  if (S.titleOv !== false && E.meta && E.meta.title) {
    drawTitleOverlay(c, W, H, E.meta.title);
  }
}

function drawTitleOverlay(c, W, bottom, title) {
  if (!c || !title) return;
  const t = String(title).slice(0, 40);
  c.save();
  c.font = '600 13px system-ui, sans-serif';
  c.textAlign = 'left';
  c.textBaseline = 'alphabetic';
  const pad = 16;
  const tw = Math.min(c.measureText(t).width + pad, W - 16);
  c.fillStyle = 'rgba(10,8,6,0.72)';
  c.fillRect(8, bottom - 26, tw, 18);
  c.fillStyle = '#c5a46e';
  c.fillText(t, 16, bottom - 12);
  c.restore();
}

function redrawEditor() {
  const cnv = $('edit-canvas');
  if (!cnv || !E.meta) return;
  const c = cnv.getContext('2d');
  const W = cnv.width, H = cnv.height;

  if (S.editView === 'spec' && E.buffer) {
    const img = ensureSpectrogram();
    c.fillStyle = '#0a0806';
    c.fillRect(0, 0, W, H);
    if (img) c.drawImage(img, 0, 0, W, H);
    // 주파수 축 안내
    const nyq = E.buffer.sampleRate / 2;
    const melMin = hzToMel(60), melMax = hzToMel(Math.min(nyq, 12000));
    c.font = '9px system-ui, sans-serif';
    c.textAlign = 'right';
    c.textBaseline = 'middle';
    [200, 500, 1000, 2000, 5000, 10000].forEach(hz => {
      if (hz > Math.min(nyq, 12000)) return;
      const y = (1 - (hzToMel(hz) - melMin) / (melMax - melMin)) * (H - 1);
      c.fillStyle = 'rgba(245,230,195,0.10)';
      c.fillRect(0, y, W, 1);
      // 데이터 위에 겹쳐도 읽히도록 라벨 뒤에 어두운 받침
      const label = hz >= 1000 ? (hz / 1000) + 'k' : String(hz);
      const ly = clamp(y, 7, H - 7);
      c.fillStyle = 'rgba(10,8,6,0.72)';
      c.fillRect(2, ly - 6, 28, 12);
      c.fillStyle = 'rgba(245,230,195,0.65)';
      c.fillText(label, 27, ly);
    });
    c.textBaseline = 'alphabetic';
    c.fillStyle = 'rgba(163,138,102,0.75)';
    c.textAlign = 'right';
    c.fillText('Mel 스케일 • Hz', W - 6, H - 5);
  } else {
    drawWaveInto(c, W, H);
  }
  drawEditOverlay(c, W, H);
  drawRuler();
  drawMinimapViewport();

  const pr = $('pos-read');
  if (pr) pr.textContent = fmtTime(currentPlayTime(), true);
}

/* 미니맵 — 긴 녹음에서 지금 어디를 보고 있는지 알려준다 */
let minimapBase = null;

function drawMinimap() {
  const cnv = $('minimap');
  if (!cnv) return;
  const W = cnv.width, H = cnv.height;
  const off = document.createElement('canvas');
  off.width = W; off.height = H;
  const oc = off.getContext('2d');
  oc.fillStyle = '#0e0b08';
  oc.fillRect(0, 0, W, H);

  if (E.buffer && E.mip) {
    const cy = H / 2;
    const spp = E.buffer.length / W;
    oc.fillStyle = 'rgba(197,164,110,0.72)';
    for (let x = 0; x < W; x++) {
      const a = Math.floor(x * spp / E.mip.stride);
      const b = Math.max(a + 1, Math.floor((x + 1) * spp / E.mip.stride));
      let lo = 1, hi = -1;
      for (let i = a; i < b && i < E.mip.min.length; i++) {
        if (E.mip.min[i] < lo) lo = E.mip.min[i];
        if (E.mip.max[i] > hi) hi = E.mip.max[i];
      }
      if (lo > hi) { lo = 0; hi = 0; }
      oc.fillRect(x, cy - hi * cy * 0.9, 1, Math.max(1, (hi - lo) * cy * 0.9));
    }
  }
  minimapBase = off;
  drawMinimapViewport();
}

function drawMinimapViewport() {
  const cnv = $('minimap');
  if (!cnv || !minimapBase || !E.meta) return;
  const c = cnv.getContext('2d');
  const W = cnv.width, H = cnv.height;
  c.clearRect(0, 0, W, H);
  c.drawImage(minimapBase, 0, 0);

  const dur = Math.max(0.01, E.meta.duration);
  const xa = E.t0 / dur * W, xb = E.t1 / dur * W;
  c.fillStyle = 'rgba(10,8,6,0.55)';
  c.fillRect(0, 0, xa, H);
  c.fillRect(xb, 0, W - xb, H);
  c.strokeStyle = '#c5a46e';
  c.lineWidth = 1.5;
  c.strokeRect(xa, 1, Math.max(2, xb - xa), H - 2);

  // 마커 — 조감도 위에도 얇게 찍어 전체 분포를 보여준다
  if (E.markers.length) {
    E.markers.forEach(m => {
      const mx = m.t / dur * W;
      c.fillStyle = m.kind === 'auto' ? 'rgba(197,164,110,0.55)' : 'rgba(224,196,138,0.85)';
      c.fillRect(mx, 0, 1, H);
    });
  }

  const px = currentPlayTime() / dur * W;
  c.fillStyle = 'rgba(255,255,255,0.8)';
  c.fillRect(px, 0, 1, H);
}

/* ═══════════════════ 12. 줌 / 이동 ═══════════════════ */

function setView(t0, t1) {
  if (!E.meta) return;
  const dur = Math.max(0.01, E.meta.duration);
  const span = clamp(t1 - t0, 0.02, dur);
  let a = t0;
  if (a < 0) a = 0;
  if (a + span > dur) a = dur - span;
  E.t0 = Math.max(0, a);
  E.t1 = E.t0 + span;
  redrawEditor();
}

function zoomBy(factor, anchorT) {
  const span = viewSpan();
  const a = anchorT == null ? (E.t0 + span / 2) : anchorT;
  const ns = span * factor;
  const ratio = (a - E.t0) / span;
  setView(a - ns * ratio, a - ns * ratio + ns);
}

function zoomFit() {
  if (!E.meta) return;
  setView(0, E.meta.duration);
}

/* ═══════════════════ 13. 재생 엔진 ═══════════════════ */
/* AudioBufferSourceNode를 쓰면 구간 반복과 배속을 정확히 제어할 수 있고,
   플레이헤드 위치도 오디오 클럭 기준이라 화면과 소리가 어긋나지 않는다. */

function currentPlayTime() {
  if (!P.playing || !audioCtx) return P.pos;
  const el = (audioCtx.currentTime - P.startedAt) * P.rate;
  let t = P.offset + el;
  if (P.loop && E.sel) {
    const a = Math.min(E.sel.a, E.sel.b), b = Math.max(E.sel.a, E.sel.b);
    const span = b - a;
    if (span > 0.01 && t >= b) t = a + ((t - a) % span);
  }
  const dur = E.meta ? E.meta.duration : 0;
  return clamp(t, 0, dur);
}

function stopPlayback() {
  if (P.src) {
    try { P.src.onended = null; P.src.stop(); } catch (e) {}
    try { P.src.disconnect(); } catch (e) {}
  }
  P.src = null;
  P.playing = false;
  cancelAnimationFrame(P.raf);
  const b = $('play-btn');
  if (b) b.textContent = '▶ 재생';
}

function playFrom(t) {
  if (!E.buffer) {
    // 디코딩이 안 되는 형식이면 브라우저 기본 재생기로라도 들려준다
    fallbackPlay();
    return;
  }
  const ctx = ctxGet();
  if (!ctx) return;
  stopPlayback();

  const src = ctx.createBufferSource();
  src.buffer = E.buffer;
  src.playbackRate.value = P.rate;

  let offset = clamp(t == null ? P.pos : t, 0, Math.max(0, E.buffer.duration - 0.01));
  if (P.loop && E.sel) {
    const a = Math.min(E.sel.a, E.sel.b), b = Math.max(E.sel.a, E.sel.b);
    if (b - a > 0.02) {
      src.loop = true;
      src.loopStart = a;
      src.loopEnd = b;
      if (offset < a || offset > b) offset = a;
    }
  }

  src.connect(ctx.destination);
  src.onended = () => {
    if (P.src === src && !src.loop) {
      P.pos = E.buffer.duration;
      stopPlayback();
      redrawEditor();
    }
  };
  src.start(0, offset);

  P.src = src;
  P.offset = offset;
  P.startedAt = ctx.currentTime;
  P.playing = true;
  const b = $('play-btn');
  if (b) b.textContent = '❚❚ 일시정지';
  playLoop();
}

function playLoop() {
  if (!P.playing) return;
  redrawEditor();
  P.raf = requestAnimationFrame(playLoop);
}

function togglePlay() {
  if (P.playing) {
    P.pos = currentPlayTime();
    stopPlayback();
    redrawEditor();
  } else {
    playFrom(P.pos);
  }
}

let fallbackAudio = null;
function fallbackPlay() {
  if (!E.blob) return;
  if (fallbackAudio && !fallbackAudio.paused) { fallbackAudio.pause(); return; }
  if (fallbackAudio) { try { URL.revokeObjectURL(fallbackAudio.src); } catch (e) {} }
  fallbackAudio = new Audio(URL.createObjectURL(E.blob));
  fallbackAudio.play().catch(() => toast('재생할 수 없습니다.'));
  toast('이 형식은 편집 없이 재생만 가능합니다.');
}

/* ═══════════════════ 14. 선택 구간 ═══════════════════ */

function updateSelReadout() {
  const el = $('sel-read');
  if (!el) return;
  const trim = $('act-trim');
  if (!E.sel) {
    el.textContent = '없음 — 파형을 드래그해 선택하세요';
    if (trim) trim.disabled = true;
    return;
  }
  const a = Math.min(E.sel.a, E.sel.b), b = Math.max(E.sel.a, E.sel.b);
  el.textContent = `${fmtTime(a, true)} → ${fmtTime(b, true)}  (${(b - a).toFixed(2)}초)`;
  if (trim) trim.disabled = (b - a) < 0.05 || !E.buffer;
}

function setSel(a, b) {
  if (a == null) {
    E.sel = null;
  } else {
    const dur = E.meta ? E.meta.duration : 0;
    E.sel = { a: clamp(a, 0, dur), b: clamp(b, 0, dur) };
  }
  updateSelReadout();
  redrawEditor();
}

/* ═══════════════════ 15. 액션 ═══════════════════ */

function downloadBlob(blob, filename) {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return true;
  } catch (e) {
    toast('내보내기 실패: ' + e.message);
    return false;
  }
}

function safeName(s) {
  return (s || 'recording').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 48);
}

async function saveCurrentToLibrary() {
  try{bumpAeStreak('save');}catch(e){}
  if (!E.meta || !E.blob) return;
  await requestPersistence();

  const titleEl = $('clip-title');
  E.meta.title = ((titleEl && titleEl.value) || '').trim() || E.meta.title;
  E.meta.markers = E.markers.map(m => ({ t: m.t, label: m.label, kind: m.kind }));

  const ok = await putBlob(E.meta.id, E.blob);
  if (!ok) {
    toast('저장에 실패했습니다. 저장 공간을 확인하세요.');
    return;
  }

  const idx = S.clips.findIndex(c => c.id === E.meta.id);
  if (idx >= 0) S.clips[idx] = E.meta;
  else S.clips.unshift(E.meta);
  saveMeta();
  E.dirty = false;

  if (window.legionTrack) window.legionTrack('activate');
  toast('내 녹음에 저장했습니다');
  storageLine();
  renderLibrary();
}

async function trimToNewClip() {
  if (!E.buffer || !E.sel) return;
  const a = Math.min(E.sel.a, E.sel.b), b = Math.max(E.sel.a, E.sel.b);
  if (b - a < 0.05) return;

  // 비파괴: 원본 메타/blob은 손대지 않고 새 레코드를 만든다.
  const sliced = sliceBuffer(E.buffer, a, b);
  const wav = encodeWAV(sliced, 0, sliced.duration, parent.title + ` (${a.toFixed(1)}–${b.toFixed(1)}초)`);
  const parent = E.meta;

  // 원본이 아직 저장 전이면 먼저 저장해 부모가 사라지지 않게 한다.
  if (E.dirty) await saveCurrentToLibrary();

  const meta = {
    id: Date.now(),
    title: parent.title + ` (${a.toFixed(1)}–${b.toFixed(1)}초)`,
    createdAt: new Date().toISOString(),
    duration: sliced.duration,
    size: wav.size,
    mime: 'audio/wav',
    ext: 'wav',
    peaks: envelopeFromBuffer(sliced),
    note: '',
    fav: false, deleted: false, deletedAt: null,
    derivedFrom: parent.id,
    dbfsPeak: Math.round(peakDbOf(sliced) * 10) / 10,
    sampleRate: sliced.sampleRate,
    markers: []
  };

  await openClip(meta, wav, true);
  await saveCurrentToLibrary();
  toast('선택 구간을 새 녹음으로 저장했습니다 (원본 유지)');
}

function exportWav() {
  if (!E.buffer) { toast('이 형식은 WAV로 변환할 수 없습니다. 원본 파일로 내보내세요.'); return; }
  const useSel = E.sel && Math.abs(E.sel.b - E.sel.a) > 0.05;
  const a = useSel ? Math.min(E.sel.a, E.sel.b) : 0;
  const b = useSel ? Math.max(E.sel.a, E.sel.b) : E.buffer.duration;
  const blob = encodeWAV(E.buffer, a, b, E.meta.title);
  const name = safeName(E.meta.title) + (useSel ? '-구간' : '') + '.wav';
  if (downloadBlob(blob, name)) {
    if (window.legionTrack) window.legionTrack('share');
    if (blob.arrayBuffer) {
      blob.arrayBuffer().then(ab => paintWavInamCheck(wavReadInam(ab))).catch(() => paintWavInamCheck(''));
    } else {
      paintWavInamCheck(E.meta && E.meta.title);
    }
    toast(useSel ? '선택 구간 WAV · 제목 메타' : 'WAV · 제목 메타');
  }
}

function exportOriginal() {
  if (!E.blob || !E.meta) return;
  const name = safeName(E.meta.title) + '.' + (E.meta.ext || extFor(E.meta.mime));
  if (downloadBlob(E.blob, name)) {
    if (window.legionTrack) window.legionTrack('share');
    toast('원본 파일을 내보냈습니다 (.' + (E.meta.ext || '') + ')');
  }
}

// WAVE96 PNG + WAVE103 영상: 동일 크롬·오버레이. 서버 STT 0. lung 원본.
function paintExportChrome(c, src) {
  if (!c || !src || !E.meta) return;
  const W = src.width, H = src.height + 76;
  const out = c.canvas;
  if (out.width !== W) out.width = W;
  if (out.height !== H) out.height = H;
  c.fillStyle = '#0a0806';
  c.fillRect(0, 0, W, H);
  c.drawImage(src, 0, 46);

  if (S.titleOv === false) {
    c.fillStyle = '#c5a46e';
    c.font = '600 20px system-ui, sans-serif';
    c.textAlign = 'left';
    c.fillText(E.meta.title, 18, 30);
  }

  c.fillStyle = 'rgba(163,138,102,0.9)';
  c.font = '12px system-ui, sans-serif';
  c.textAlign = 'right';
  c.fillText(`${fmtTime(E.meta.duration, true)} • ${S.editView === 'spec' ? 'Mel 스펙트로그램' : '파형'}`, W - 18, 30);
  c.textAlign = 'left';
  c.fillText('Aether Canvas', 18, H - 12);

  if (S.titleOv !== false && E.meta.title) {
    drawTitleOverlay(c, W, 46 + src.height, E.meta.title);
  }
}

// 지금 보고 있는 화면(파형/스펙트로그램)을 제목과 함께 이미지로 굽는다.
function exportPng() {
  const src = $('edit-canvas');
  if (!src || !E.meta) return;
  const out = document.createElement('canvas');
  paintExportChrome(out.getContext('2d'), src);

  out.toBlob(b => {
    if (!b) { toast('이미지 생성에 실패했습니다.'); return; }
    if (downloadBlob(b, safeName(E.meta.title) + '.png')) {
      if (window.legionTrack) window.legionTrack('share');
      toast(S.titleOv !== false ? '이미지로 내보냈습니다 · 제목 오버레이' : '이미지로 내보냈습니다');
    }
  }, 'image/png');
}

/* GOLD50 TOP3: 캔버스+오디오 MediaRecorder 파형 영상. 서버 업로드 0. lung 미수정. */
const VID_MIME = [
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9,opus',
  'video/webm',
  'video/mp4'
];
let vidRec = null;

function pickVidMime() {
  if (!window.MediaRecorder) return null;
  if (!MediaRecorder.isTypeSupported) return '';
  for (const m of VID_MIME) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) {}
  }
  return '';
}

function exportWaveVideo() {
  if (vidRec) { toast('이미 영상을 만드는 중'); return; }
  if (!E.buffer || !E.meta) { toast('클립을 연 뒤 파형 영상을 보내세요'); return; }
  const cnv = $('edit-canvas');
  if (!cnv || typeof cnv.captureStream !== 'function') {
    toast('이 브라우저는 캔버스 영상 캡처를 지원하지 않습니다');
    return;
  }
  const mime = pickVidMime();
  if (mime === null) { toast('MediaRecorder 없음'); return; }
  const ctx = ctxGet();
  if (!ctx) { toast('오디오 컨텍스트를 열 수 없습니다'); return; }

  switchTab('edit');
  redrawEditor();

  const useSel = E.sel && Math.abs(E.sel.b - E.sel.a) > 0.05;
  const tA = useSel ? Math.min(E.sel.a, E.sel.b) : 0;
  const tB = useSel ? Math.max(E.sel.a, E.sel.b) : E.buffer.duration;
  const dur = Math.max(0.4, Math.min(12, tB - tA));

  const dest = ctx.createMediaStreamDestination();
  const src = ctx.createBufferSource();
  src.buffer = E.buffer;
  src.connect(dest);
  src.connect(ctx.destination);

  // WAVE103: PNG와 동일 오버레이를 영상 프레임에. 서버 STT 0. lung 원본.
  const vidCnv = document.createElement('canvas');
  paintExportChrome(vidCnv.getContext('2d'), cnv);
  let capCnv = vidCnv;
  if (typeof vidCnv.captureStream !== 'function') capCnv = cnv;
  const vStream = capCnv.captureStream(30);
  const mixed = new MediaStream(
    vStream.getVideoTracks().concat(dest.stream.getAudioTracks())
  );
  let rec;
  try {
    rec = mime ? new MediaRecorder(mixed, { mimeType: mime }) : new MediaRecorder(mixed);
  } catch (e) {
    rec = new MediaRecorder(mixed);
  }
  const chunks = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    vidRec = null;
    try { src.stop(); } catch (e) {}
    try { src.disconnect(); dest.disconnect(); } catch (e) {}
    vStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
    const type = rec.mimeType || mime || 'video/webm';
    const blob = new Blob(chunks, { type: type });
    const ext = /mp4/i.test(type) ? 'mp4' : 'webm';
    if (blob.size < 64) { toast('영상이 비었습니다. 다른 브라우저를 시도하세요.'); return; }
    if (downloadBlob(blob, safeName(E.meta.title) + '-wave.' + ext)) {
      if (window.legionTrack) window.legionTrack('share');
      toast(S.titleOv !== false ? '파형 영상을 내보냈습니다 · 제목 오버레이 · 서버 0' : '파형 영상을 내보냈습니다 (로컬 · 서버 0)');
    }
  };

  stopPlayback();
  vidRec = rec;
  rec.start(200);
  src.start(0, tA, dur);
  P.src = src;
  P.offset = tA;
  P.startedAt = ctx.currentTime;
  P.playing = true;
  const pb = $('play-btn');
  if (pb) pb.textContent = '❚❚ 일시정지';
  playLoop();
  (function vidPaint() {
    if (vidRec !== rec) return;
    if (capCnv === vidCnv) paintExportChrome(vidCnv.getContext('2d'), cnv);
    requestAnimationFrame(vidPaint);
  })();
  setTimeout(() => {
    if (vidRec === rec && rec.state === 'recording') {
      try { rec.stop(); } catch (e) {}
    }
    if (P.src === src) stopPlayback();
  }, Math.round(dur * 1000) + 280);
  toast('파형 영상 캡처 중… ' + dur.toFixed(1) + '초 · ' + (S.titleOv !== false ? '제목 오버레이 · ' : '') + '서버 없음');
}

/* ═══════════════════ 16. 라이브러리 ═══════════════════ */

function updateLibCount() {
  const el = $('lib-count');
  if (el) el.textContent = String(S.clips.filter(c => !c.deleted).length);
}

function drawEnvelope(cnv, peaks) {
  if (!cnv) return;
  const c = cnv.getContext('2d');
  const W = cnv.width, H = cnv.height, cy = H / 2;
  c.fillStyle = '#0a0806';
  c.fillRect(0, 0, W, H);
  if (!peaks || !peaks.length) {
    c.fillStyle = 'rgba(197,164,110,0.22)';
    c.fillRect(0, cy - 0.5, W, 1);
    return;
  }
  const bw = W / peaks.length;
  for (let i = 0; i < peaks.length; i++) {
    const p = Math.max(0.02, peaks[i]);
    const bh = p * (H * 0.44);
    c.fillStyle = `rgba(197,164,110,${0.3 + p * 0.5})`;
    c.fillRect(i * bw, cy - bh, Math.max(1, bw - 0.7), bh * 2);
  }
}

function filteredClips() {
  const q = S.search.trim().toLowerCase();
  return S.clips.filter(c => {
    if (S.filter === 'trash') { if (!c.deleted) return false; }
    else if (c.deleted) return false;
    if (S.filter === 'fav' && !c.fav) return false;
    if (q) {
      const hay = ((c.title || '') + ' ' + (c.note || '') + ' ' + (c.caption || '')).toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  });
}

function mkBtn(label, fn, cls) {
  const b = document.createElement('button');
  b.className = 'mini' + (cls ? ' ' + cls : '');
  b.textContent = label;
  b.addEventListener('click', fn);
  return b;
}

function renderLibrary() {
  try{renderAeLoop();}catch(e){}
  const list = $('lib-list');
  if (!list) return;
  list.innerHTML = '';
  const items = filteredClips();

  if (!items.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = S.filter === 'trash'
      ? '휴지통이 비어 있습니다.'
      : (S.search ? '검색 결과가 없습니다.' : '아직 저장된 녹음이 없습니다. 먼저 녹음해 보세요.');
    list.appendChild(e);
    updateLibCount();
    return;
  }

  items.forEach(c => {
    const row = document.createElement('div');
    row.className = 'lib-item' + (c.deleted ? ' is-trashed' : '');

    const cnv = document.createElement('canvas');
    cnv.width = 260; cnv.height = 40;
    cnv.className = 'lib-env';
    row.appendChild(cnv);

    const body = document.createElement('div');
    body.className = 'lib-body';

    const t = document.createElement('div');
    t.className = 'lib-title';
    t.textContent = c.title;
    body.appendChild(t);

    const meta = document.createElement('div');
    meta.className = 'lib-meta';
    const d = new Date(c.createdAt);
    const bits = [
      `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
      fmtTime(c.duration, false),
      fmtBytes(c.size)
    ];
    if (c.derivedFrom) bits.push('편집본');
    meta.textContent = bits.join(' • ');
    body.appendChild(meta);

    if (c.note) {
      const n = document.createElement('div');
      n.className = 'lib-note';
      n.textContent = c.note;
      body.appendChild(n);
    }
    row.appendChild(body);

    const acts = document.createElement('div');
    acts.className = 'lib-acts';

    if (c.deleted) {
      acts.appendChild(mkBtn('복구', () => {
        c.deleted = false; c.deletedAt = null; saveMeta(); renderLibrary();
        toast('복구했습니다');
      }));
      acts.appendChild(mkBtn('영구 삭제', async () => {
        if (!confirm('이 녹음을 완전히 지웁니다. 되돌릴 수 없습니다.')) return;
        await delBlob(c.id);
        S.clips = S.clips.filter(x => x.id !== c.id);
        saveMeta(); renderLibrary(); storageLine();
      }, 'danger'));
    } else {
      const fav = mkBtn(c.fav ? '★' : '☆', () => {
        c.fav = !c.fav; saveMeta(); renderLibrary();
      }, c.fav ? 'fav on' : 'fav');
      fav.title = '즐겨찾기';
      acts.appendChild(fav);

      acts.appendChild(mkBtn('열기', async () => {
        const blob = await getBlob(c.id);
        if (!blob) { toast('저장된 오디오를 찾을 수 없습니다.'); return; }
        await openClip(c, blob, false);
      }));

      acts.appendChild(mkBtn('이름', () => {
        const v = prompt('제목', c.title);
        if (v != null && v.trim()) { c.title = v.trim().slice(0, 60); saveMeta(); renderLibrary(); }
      }));

      acts.appendChild(mkBtn('메모', () => {
        const v = prompt('메모 (검색됩니다)', c.note || '');
        if (v != null) { c.note = v.trim().slice(0, 300); saveMeta(); renderLibrary(); }
      }));

      acts.appendChild(mkBtn('삭제', () => {
        c.deleted = true; c.deletedAt = new Date().toISOString();
        saveMeta(); renderLibrary();
        toast(`휴지통으로 옮겼습니다 (${TRASH_DAYS}일 안에 복구 가능)`);
      }));
    }

    row.appendChild(acts);
    list.appendChild(row);
    drawEnvelope(cnv, c.peaks);
  });

  updateLibCount();
}

/* ═══════════════════ 17. 탭 ═══════════════════ */

function switchTab(name) {
  S.tab = name;
  document.querySelectorAll('.tab').forEach(t => {
    const on = t.dataset.tab === name;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.panel').forEach(p => {
    p.classList.toggle('is-active', p.dataset.panel === name);
  });
  if (name === 'library') { renderLibrary(); storageLine(); }
  if (name === 'edit' && E.meta) redrawEditor();
}

/* ═══════════════════ 18. 입력 배선 ═══════════════════ */

function canvasPos(cnv, ev) {
  const r = cnv.getBoundingClientRect();
  const src = (ev.touches && ev.touches[0]) || (ev.changedTouches && ev.changedTouches[0]) || ev;
  return (src.clientX - r.left) / r.width * cnv.width;
}

function wireEditCanvas() {
  const cnv = $('edit-canvas');
  if (!cnv) return;
  const W = cnv.width;
  let mode = null;     // 'new' | 'a' | 'b'
  let moved = false;

  const handleAt = x => {
    if (!E.sel) return null;
    const xa = timeToX(Math.min(E.sel.a, E.sel.b), W);
    const xb = timeToX(Math.max(E.sel.a, E.sel.b), W);
    // 핸들은 넉넉히 잡히게: 거친 조작(새 선택)과 미세 조작(끝점)을 나눈다
    if (Math.abs(x - xa) <= 9) return 'a';
    if (Math.abs(x - xb) <= 9) return 'b';
    return null;
  };

  const down = ev => {
    if (!E.meta) return;
    const x = canvasPos(cnv, ev);
    const t = xToTime(x, W);
    moved = false;
    const h = handleAt(x);
    if (h) mode = h;
    else { mode = 'new'; setSel(t, t); }
    ev.preventDefault();
  };

  const move = ev => {
    if (!mode || !E.meta) return;
    const t = xToTime(canvasPos(cnv, ev), W);
    moved = true;
    if (mode === 'new') setSel(E.sel ? E.sel.a : t, t);
    else if (mode === 'a') setSel(t, E.sel.b);
    else if (mode === 'b') setSel(E.sel.a, t);
    ev.preventDefault();
  };

  const up = ev => {
    if (!mode) return;
    const wasNew = mode === 'new';
    mode = null;
    if (wasNew && !moved) {
      // 드래그 없이 클릭하면 그 지점으로 재생 위치를 옮긴다 (스크러빙)
      const t = xToTime(canvasPos(cnv, ev), W);
      setSel(null);
      P.pos = clamp(t, 0, E.meta.duration);
      if (P.playing) playFrom(P.pos); else redrawEditor();
    } else if (E.sel && Math.abs(E.sel.b - E.sel.a) < 0.02) {
      setSel(null);
    }
  };

  cnv.addEventListener('mousedown', down);
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
  cnv.addEventListener('touchstart', down, { passive: false });
  cnv.addEventListener('touchmove', move, { passive: false });
  cnv.addEventListener('touchend', up);

  // 휠 = 확대/축소(커서 위치 기준), Shift+휠 = 좌우 이동
  cnv.addEventListener('wheel', ev => {
    if (!E.meta) return;
    ev.preventDefault();
    const anchor = xToTime(canvasPos(cnv, ev), W);
    if (ev.shiftKey) {
      const d = viewSpan() * (ev.deltaY > 0 ? 0.12 : -0.12);
      setView(E.t0 + d, E.t1 + d);
    } else {
      zoomBy(ev.deltaY > 0 ? 1.22 : 0.82, anchor);
    }
  }, { passive: false });

  cnv.addEventListener('dblclick', zoomFit);
}

function wireMinimap() {
  const cnv = $('minimap');
  if (!cnv) return;
  let dragging = false;
  const jump = ev => {
    if (!E.meta) return;
    const t = canvasPos(cnv, ev) / cnv.width * E.meta.duration;
    const span = viewSpan();
    setView(t - span / 2, t + span / 2);
  };
  cnv.addEventListener('mousedown', e => { dragging = true; jump(e); });
  window.addEventListener('mousemove', e => { if (dragging) jump(e); });
  window.addEventListener('mouseup', () => { dragging = false; });
  cnv.addEventListener('touchstart', e => { jump(e); e.preventDefault(); }, { passive: false });
  cnv.addEventListener('touchmove', e => { jump(e); e.preventDefault(); }, { passive: false });
}

function wireRuler() {
  const cnv = $('ruler');
  if (!cnv) return;
  const seek = ev => {
    if (!E.meta) return;
    const t = xToTime(canvasPos(cnv, ev), cnv.width);
    P.pos = clamp(t, 0, E.meta.duration);
    if (P.playing) playFrom(P.pos); else redrawEditor();
  };
  cnv.addEventListener('mousedown', seek);
  cnv.addEventListener('touchstart', e => { seek(e); e.preventDefault(); }, { passive: false });
}

function wireControls() {
  $('rec-btn').addEventListener('click', startRecording);
  $('stop-btn').addEventListener('click', stopRecording);
  window.addEventListener('offline', function () {
    if (R.recording) {
      stopCaption();
      setCaptionNote('오프라인 — 캡션 실패. 이 앱은 서버 STT를 쓰지 않습니다.', true);
    }
  });

  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => switchTab(t.dataset.tab));
  });

  document.querySelectorAll('[data-liveview]').forEach(b => {
    b.addEventListener('click', () => {
      S.liveView = b.dataset.liveview;
      document.querySelectorAll('[data-liveview]').forEach(x => x.classList.toggle('is-active', x === b));
      liveSpecInit = false;
      if (!R.recording) { clearLive(); drawLiveIdle(); }
    });
  });

  document.querySelectorAll('[data-fft]').forEach(b => {
    b.addEventListener('click', () => applyFftSize(Number(b.dataset.fft)));
  });

  document.querySelectorAll('[data-editview]').forEach(b => {
    b.addEventListener('click', () => {
      S.editView = b.dataset.editview;
      document.querySelectorAll('[data-editview]').forEach(x => x.classList.toggle('is-active', x === b));
      if (S.editView === 'wave') $('spec-busy').classList.add('hidden');
      redrawEditor();
    });
  });

  document.querySelectorAll('[data-filter]').forEach(b => {
    b.addEventListener('click', () => {
      S.filter = b.dataset.filter;
      document.querySelectorAll('[data-filter]').forEach(x => x.classList.toggle('is-active', x === b));
      renderLibrary();
    });
  });

  $('lib-search').addEventListener('input', e => { S.search = e.target.value; renderLibrary(); });

  $('zoom-in').addEventListener('click', () => zoomBy(0.6, currentPlayTime()));
  $('zoom-out').addEventListener('click', () => zoomBy(1.7, currentPlayTime()));
  $('zoom-fit').addEventListener('click', zoomFit);

  $('play-btn').addEventListener('click', togglePlay);
  try { S.titleOv = localStorage.getItem('aether_title_ov') !== '0'; } catch (e) { S.titleOv = true; }
  (function markTitleOv() {
    const el = $('title-ov');
    if (el) el.classList.toggle('on', S.titleOv !== false);
  })();
  function markLoopLenChips(sec) {
    [4, 8, 12].forEach(n => {
      const el = $('loop-' + n);
      if (el) el.classList.toggle('on', n === sec);
    });
  }
  function applyLoopLen(sec) {
    if (!E.meta) { toast('클립을 먼저 여세요'); return; }
    const end = E.meta.duration || 0;
    let a = currentPlayTime();
    let b = Math.min(end, a + sec);
    if (b - a < 0.2) {
      a = Math.max(0, end - sec);
      b = end;
    }
    if (b - a < 0.05) { toast('클립이 너무 짧습니다'); return; }
    P.loopLen = sec;
    P.loop = true;
    setSel(a, b);
    const lb = $('loop-btn');
    if (lb) lb.classList.toggle('on', true);
    markLoopLenChips(sec);
    if (P.playing) playFrom(a);
    toast(sec + '초 루프 · 서버 없음');
  }
  $('loop-btn').addEventListener('click', () => {
    P.loop = !P.loop;
    if (!P.loop) {
      P.loopLen = 0;
      markLoopLenChips(0);
    }
    $('loop-btn').classList.toggle('on', P.loop);
    if (P.loop && !E.sel) toast('구간을 먼저 드래그해 선택하세요');
    if (P.playing) playFrom(currentPlayTime());
  });
  [4, 8, 12].forEach(n => {
    const el = $('loop-' + n);
    if (el) el.addEventListener('click', () => applyLoopLen(n));
  });
  const tov = $('title-ov');
  if (tov) tov.addEventListener('click', () => {
    S.titleOv = !S.titleOv;
    try { localStorage.setItem('aether_title_ov', S.titleOv ? '1' : '0'); } catch (e) {}
    tov.classList.toggle('on', S.titleOv !== false);
    redrawEditor();
    toast(S.titleOv ? '제목 오버레이 ON · 서버 없음' : '제목 오버레이 OFF');
  });
  $('speed').addEventListener('change', e => {
    P.rate = parseFloat(e.target.value) || 1;
    if (P.playing) playFrom(currentPlayTime());
  });

  $('sel-clear').addEventListener('click', () => setSel(null));
  $('sel-all').addEventListener('click', () => { if (E.meta) setSel(0, E.meta.duration); });

  $('mk-detect').addEventListener('click', runSilenceDetect);
  $('mk-add').addEventListener('click', () => { if (E.meta) addMarker(currentPlayTime()); });
  $('mk-prev').addEventListener('click', () => gotoMarker(-1));
  $('mk-next').addEventListener('click', () => gotoMarker(1));
  $('mk-trim').addEventListener('click', trimSilenceSelect);
  $('mk-clear').addEventListener('click', clearMarkers);

  $('clip-title').addEventListener('change', e => {
    if (!E.meta) return;
    E.meta.title = (e.target.value || '').trim().slice(0, 60) || E.meta.title;
    e.target.value = E.meta.title;
    if (!E.dirty) saveMeta();
    redrawEditor();
  });

  $('act-save').addEventListener('click', saveCurrentToLibrary);
  $('act-trim').addEventListener('click', trimToNewClip);
  $('act-wav').addEventListener('click', exportWav);
  $('act-orig').addEventListener('click', exportOriginal);
  $('act-png').addEventListener('click', exportPng);
  $('act-vid').addEventListener('click', exportWaveVideo);
}

function wireKeyboard() {
  document.addEventListener('keydown', e => {
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (e.code === 'Space') {
      e.preventDefault();
      if (S.tab === 'edit' && E.meta) togglePlay();
      else if (R.recording) stopRecording();
      else startRecording();
      return;
    }
    if (S.tab !== 'edit' || !E.meta) return;

    const k = e.key.toLowerCase();
    const nudge = e.shiftKey ? 0.1 : 1;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      P.pos = clamp(currentPlayTime() - nudge, 0, E.meta.duration);
      if (P.playing) playFrom(P.pos); else redrawEditor();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      P.pos = clamp(currentPlayTime() + nudge, 0, E.meta.duration);
      if (P.playing) playFrom(P.pos); else redrawEditor();
    } else if (e.key === 'Home') {
      P.pos = 0;
      if (P.playing) playFrom(0); else redrawEditor();
    } else if (k === 'l') {
      $('loop-btn').click();
    } else if (k === 'i') {
      setSel(currentPlayTime(), E.sel ? E.sel.b : currentPlayTime());
    } else if (k === 'o') {
      setSel(E.sel ? E.sel.a : 0, currentPlayTime());
    } else if (k === 's') {
      const target = document.querySelector('[data-editview="' + (S.editView === 'spec' ? 'wave' : 'spec') + '"]');
      if (target) target.click();
    } else if (k === 'm') {
      addMarker(currentPlayTime());
    } else if (e.key === '[') {
      e.preventDefault();
      gotoMarker(-1);
    } else if (e.key === ']') {
      e.preventDefault();
      gotoMarker(1);
    } else if (e.key === '+' || e.key === '=') {
      zoomBy(0.6, currentPlayTime());
    } else if (e.key === '-' || e.key === '_') {
      zoomBy(1.7, currentPlayTime());
    } else if (e.key === '0') {
      zoomFit();
    }
  });
}

/* ═══════════════════ 19. 시작 ═══════════════════ */

window.addEventListener('load', () => {
  loadMeta();
  updateLibCount();
  describeFormat();
  wireControls();
  wireEditCanvas();
  wireMinimap();
  wireRuler();
  wireKeyboard();
  drawLiveIdle();
  resetMeter();
  storageLine();
  const trim = $('act-trim');
  if (trim) trim.disabled = true;
  const rec = $('rec-btn');
  if (rec && rec.focus) try { rec.focus(); } catch (e) {}

  window.addEventListener('beforeunload', e => {
    if (E.dirty && E.meta) { e.preventDefault(); e.returnValue = ''; }
  });
});

/* LEGION_WAVE_42_pipe_ensure */

(function(){try{
  if(document.getElementById('moneyPipe'))return;
  var d=document.createElement('div');
  d.innerHTML='<div id="moneyPipe" style="margin-top:12px;padding:10px;border:1px solid #c5a46e44;border-radius:12px;background:#16121c;text-align:center;font-size:12px"><div style="color:#e0b552;font-weight:700;margin-bottom:4px">pipe</div><a style="color:#ece8f1;margin:0 6px" href="mailto:hoyashi95@gmail.com?subject=%5BLegion%5D">mail</a><a style="color:#e0b552;margin:0 6px" href="https://hosuman08-netizen.github.io/legion-hub/">Hub</a></div>';
  var app=document.getElementById('app')||document.body;
  app.appendChild(d.firstElementChild||d);
}catch(e){}
/* LEGION_WAVE_87_share_counter */
document.addEventListener('click',function(ev){try{var el=ev.target;if(!el)return;var tx=(el.textContent||'')+(el.id||'');if(/share|copy/i.test(tx)||/\uacf5\uc720|\ubcf5\uc0ac/.test(tx)){localStorage.setItem('lw_p6_airpods_a_share_counter',String((+(localStorage.getItem('lw_p6_airpods_a_share_counter')||0))+1));}}catch(e){}},true);
})();
try{ if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', renderAeLoop); else setTimeout(renderAeLoop,80); }catch(e){}
