// Aether Canvas — 음성 아트 레코더
// Sfumato: 부드러운 다층 파형. Notebook: 녹음을 저장하고 다시 들으며 관찰.

let mediaRecorder;
let audioChunks = [];
let isRecording = false;
let startTime = 0;
let timerInterval;
let canvas, ctx;
let animationFrame;
let audioContext, analyser, source, dataArray, timeArray;
let ampAccum = 0, ampSamples = 0, ampPeak = 0; // real energy stats for the session
let currentSession = null;
// Read the current key, falling back to the legacy key for continuity.
let sessions = JSON.parse(localStorage.getItem('aether_sessions') || localStorage.getItem('p6_sessions') || '[]');

// === Persistent audio store (IndexedDB) ===
// localStorage blob URLs die on reload, which silently broke Re-listen for
// saved sessions. Store the actual audio blob keyed by session id so re-listen
// truly works after refresh — the core "save & come back to it" promise.
let _p6db = null;
function openAudioDB() {
  return new Promise((resolve) => {
    if (_p6db) return resolve(_p6db);
    if (!window.indexedDB) return resolve(null);
    try {
      const req = indexedDB.open('p6_audio', 1);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('clips')) db.createObjectStore('clips');
      };
      req.onsuccess = e => { _p6db = e.target.result; resolve(_p6db); };
      req.onerror = () => resolve(null);
    } catch(e) { resolve(null); }
  });
}
async function saveAudioBlob(id, blob) {
  const db = await openAudioDB(); if (!db) return false;
  return new Promise(res => {
    try {
      const tx = db.transaction('clips', 'readwrite');
      tx.objectStore('clips').put(blob, id);
      tx.oncomplete = () => res(true);
      tx.onerror = () => res(false);
    } catch(e) { res(false); }
  });
}
async function loadAudioBlob(id) {
  const db = await openAudioDB(); if (!db) return null;
  return new Promise(res => {
    try {
      const tx = db.transaction('clips', 'readonly');
      const r = tx.objectStore('clips').get(id);
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => res(null);
    } catch(e) { res(null); }
  });
}

// === Voiceprint: a compact peak envelope of the whole take ===
// Decodes the captured audio once and reduces it to ~72 amplitude peaks — the
// unique "fingerprint" of that voice. Stored with the session so the notebook
// can draw each recording's own shape, turning the archive from identical text
// blocks into a gallery of visibly distinct voices. Honest data: every peak is
// a real max-abs over its slice of the actual samples.
async function extractVoiceprint(blob, buckets = 72) {
  try {
    const buf = await blob.arrayBuffer();
    const AC = window.AudioContext || window.webkitAudioContext;
    const octx = new AC();
    const decoded = await octx.decodeAudioData(buf);
    const data = decoded.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / buckets));
    const peaks = [];
    for (let b = 0; b < buckets; b++) {
      let peak = 0;
      const start = b * step;
      for (let i = start; i < start + step && i < data.length; i++) {
        const a = Math.abs(data[i]);
        if (a > peak) peak = a;
      }
      peaks.push(Math.round(peak * 1000) / 1000); // 0..1, 3-decimal
    }
    try { octx.close(); } catch(e) {}
    // Normalize to the loudest peak so quiet takes still read as a full shape.
    const max = Math.max(0.0001, ...peaks);
    return peaks.map(p => Math.round((p / max) * 1000) / 1000);
  } catch(e) {
    return null; // decode can fail for exotic codecs; notebook falls back gracefully
  }
}

// Draw a saved voiceprint into a small canvas as a soft golden mirror-waveform,
// so each notebook entry shows the actual silhouette of that recording.
function drawVoiceprint(cnv, peaks) {
  if (!cnv || !peaks || !peaks.length) return;
  const c = cnv.getContext('2d');
  const w = cnv.width, h = cnv.height, cy = h / 2;
  c.clearRect(0, 0, w, h);
  c.fillStyle = '#0a0806';
  c.fillRect(0, 0, w, h);
  const bw = w / peaks.length;
  for (let i = 0; i < peaks.length; i++) {
    const p = Math.max(0.02, peaks[i]);
    const bh = p * (h * 0.44);
    const x = i * bw;
    // sfumato glaze: brighter core, softer with amplitude
    c.fillStyle = `rgba(197,164,110,${0.28 + p * 0.5})`;
    c.fillRect(x, cy - bh, Math.max(1, bw - 0.7), bh * 2);
  }
  // faint center line
  c.strokeStyle = 'rgba(242,225,188,0.18)';
  c.lineWidth = 0.7;
  c.beginPath(); c.moveTo(0, cy); c.lineTo(w, cy); c.stroke();
}

function initCanvas() {
  canvas = document.getElementById('wave-canvas');
  ctx = canvas.getContext('2d');
  drawSfumatoBackground();
}

function drawSfumatoBackground() {
  if (!ctx) return;
  ctx.fillStyle = '#0a0806';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = `rgba(197, 164, 110, ${0.03 + i * 0.015})`;
    ctx.beginPath();
    ctx.ellipse(canvas.width / 2 + (i - 2.5) * 40, canvas.height / 2, 280 - i * 20, 90 - i * 8, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawSfumatoWaveform(amplitude, time, freqData = null, timeData = null) {
  if (!ctx || !canvas) return;
  ctx.fillStyle = 'rgba(10, 8, 6, 0.38)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const centerY = canvas.height / 2;
  const width = canvas.width;
  const golden = 0.618; // golden ratio

  // === REAL oscilloscope trace: the actual time-domain waveform of the voice.
  // This is the honest core — every wiggle is a genuine mic sample, not sine math.
  // Drawn as the luminous protagonist line so the user literally sees their voice.
  if (timeData && timeData.length) {
    ctx.save();
    ctx.shadowBlur = 14;
    ctx.shadowColor = 'rgba(242, 225, 188, 0.5)';
    ctx.strokeStyle = `rgba(245, 230, 195, ${0.5 + Math.min(0.4, amplitude * 0.6)})`;
    ctx.lineWidth = 1.7;
    ctx.beginPath();
    const step = timeData.length / width;
    const gain = 0.9; // vertical scale of the raw waveform
    for (let x = 0; x < width; x++) {
      const s = timeData[Math.floor(x * step)] || 128;
      const v = (s - 128) / 128; // -1..1 real sample
      const y = centerY + v * (centerY * gain);
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  // Sfumato: 9+ ultra soft smoke glaze layers
  const layers = 9;
  for (let l = 0; l < layers; l++) {
    const alpha = 0.13 - (l * 0.011);
    const offset = (l - 4.5) * (2.1 + (l%2)*0.4);
    const hue = 36 + l * 2.1;

    ctx.strokeStyle = `hsla(${hue}, 42%, 68%, ${Math.max(0.018, alpha)})`;
    ctx.lineWidth = 2.6 + (l % 3) * 0.6;
    ctx.shadowBlur = 12 + l * 1.8;
    ctx.shadowColor = `hsla(${hue}, 55%, 78%, 0.38)`;

    ctx.beginPath();
    for (let x = 0; x < width; x += 1.8) {
      let y = centerY + offset;
      const phase = (x / 51) + (time * 0.0023) + (l * 1.05);
      y += Math.sin(phase) * (40 + amplitude * 58);
      y += Math.sin(phase * 2.6) * (13 + amplitude * 21);
      y += Math.sin(phase * 0.7) * (6 + amplitude * 11);

      // Real analyser: freq drives micro gestures on the line
      if (freqData && x % 6 === 0) {
        const idx = Math.floor(((x / width) * freqData.length) * golden);
        const boost = ((freqData[idx] || 90) / 255 - 0.48) * 31 * amplitude;
        y += boost;
      }
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Central luminous sfumato core
  ctx.shadowBlur = 26;
  ctx.shadowColor = 'rgba(235, 215, 175, 0.55)';
  ctx.strokeStyle = `rgba(242, 225, 188, ${0.62 + amplitude * 0.28})`;
  ctx.lineWidth = 1.55;
  ctx.beginPath();
  for (let x = 0; x < width; x += 2.6) {
    const phase = (x / 45) + (time * 0.0031);
    let y = centerY + Math.sin(phase) * (19 + amplitude * 46);
    if (freqData) {
      const idx = Math.floor((x / width) * freqData.length * 0.42);
      y += ((freqData[idx] || 80) / 255 - 0.5) * 24 * amplitude;
    }
    if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // === Golden detail overlay ===
  // A soft golden-ratio accent line that drifts with the voice, adding depth
  // to the sfumato waveform. Its subtle motion state persists between frames.
  let detail = JSON.parse(localStorage.getItem('aether_detail') || '{"phase":0,"age":0}');
  detail.phase = (detail.phase || 0) + (amplitude * 0.0008 + 0.0003);
  detail.age = (detail.age || 0) + 1;
  if (detail.phase > 6.28) detail.phase -= 6.28;
  localStorage.setItem('aether_detail', JSON.stringify(detail));

  ctx.strokeStyle = `rgba(242,225,188,${0.02 + (amplitude * 0.02)})`;
  ctx.lineWidth = 0.8;
  ctx.shadowBlur = 10;
  ctx.shadowColor = 'rgba(242,225,188,0.2)';
  ctx.beginPath();
  for (let x = 0; x < width; x += 4) {
    const g = 0.618;
    let y = centerY + Math.sin((x / 55) + detail.phase) * (8 + amplitude * 14);
    if (x % 11 === 0) y -= Math.sin(x * g) * 3.5 * amplitude;
    if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Golden-ratio "eye" accent at the 0.618 point of the canvas.
  if (window.drawGoldenDetail) {
    window.drawGoldenDetail(ctx, width, centerY, detail, amplitude);
  }

  // Soft freq spectrum sfumato veil (ultra subtle)
  if (freqData) {
    ctx.strokeStyle = `rgba(197,164,110,${0.07 + amplitude * 0.05})`;
    ctx.lineWidth = 1.1;
    ctx.shadowBlur = 4;
    ctx.beginPath();
    for (let x = 0; x < width; x += 5) {
      const idx = Math.floor((x / width) * freqData.length);
      const h = (freqData[idx] / 255) * 26 * amplitude;
      const y = centerY - 18 + h * 0.6;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
}

// Dedicated golden-detail canvas below the main waveform.
function drawDetailEye(amp) {
  const c = document.getElementById('detail-eye'); if (!c) return;
  const ctx = c.getContext('2d'); const w = c.width, cy = c.height * 0.5;
  ctx.fillStyle = '#0a0806'; ctx.fillRect(0,0,w,c.height);
  const detail = JSON.parse(localStorage.getItem('aether_detail') || '{"phase":1.0}');
  if (window.drawGoldenDetail) {
    window.drawGoldenDetail(ctx, w, cy, detail, amp||0.48);
  }
}

// Real Web Audio analysis: connect an AnalyserNode to the live mic (or an
// <audio> element during playback) so both the amplitude and the drawn
// waveform come from genuine sound, not synthetic sine math.
function setupAnalyser(streamOrNode, opts = {}) {
  try {
    if (!audioContext || audioContext.state === 'closed') {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioContext.state === 'suspended') audioContext.resume();
    analyser = audioContext.createAnalyser();
    // 1024 FFT → 512 freq bins + 1024 time-domain samples: enough resolution
    // to draw a real oscilloscope trace of the voice, with light smoothing so
    // the sfumato glazes stay soft rather than jittery.
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.72;
    if (streamOrNode instanceof MediaStream) {
      source = audioContext.createMediaStreamSource(streamOrNode);
      source.connect(analyser);
    } else {
      // HTMLMediaElement (playback): createMediaElementSource may only be called
      // once per element, so cache the node on the element and reuse it.
      if (streamOrNode._p6Source) {
        source = streamOrNode._p6Source;
      } else {
        source = audioContext.createMediaElementSource(streamOrNode);
        streamOrNode._p6Source = source;
      }
      try { source.disconnect(); } catch(e) {}
      source.connect(analyser);
      if (opts.toDestination !== false) analyser.connect(audioContext.destination);
    }
    dataArray = new Uint8Array(analyser.frequencyBinCount); // frequency spectrum
    timeArray = new Uint8Array(analyser.fftSize);           // time-domain waveform
    return true;
  } catch(e) { console.log('Analyser setup failed:', e.message); return false; }
}

// True loudness (RMS) from the time-domain samples. Centered at 128 (silence),
// so we measure real deviation from the zero line — no random fallback while
// a real analyser is live.
function getLiveAmplitude() {
  if (!analyser || !timeArray) return isRecording ? 0 : Math.random() * 0.3 + 0.1;
  analyser.getByteTimeDomainData(timeArray);
  let sumSq = 0;
  for (let i = 0; i < timeArray.length; i++) {
    const v = (timeArray[i] - 128) / 128; // -1..1
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / timeArray.length); // 0..~1
  return Math.min(1, rms * 3.2); // scale typical speech RMS into a full 0..1 range
}

// Snapshot the real waveform + spectrum for this frame (used by the visualizer).
function getAnalyserFrame() {
  if (!analyser || !timeArray || !dataArray) return null;
  analyser.getByteTimeDomainData(timeArray);
  analyser.getByteFrequencyData(dataArray);
  return { time: timeArray, freq: dataArray };
}

// Live loudness readout driven by real RMS amplitude (0..1). Fills the
// previously-dead #energy element with a genuine dB-ish bar + percent.
function updateEnergyReadout(amp) {
  const el = document.getElementById('energy');
  if (!el) return;
  const pct = Math.round(amp * 100);
  const bars = Math.max(0, Math.min(12, Math.round(amp * 12)));
  const filled = '▮'.repeat(bars);
  const empty = '▯'.repeat(12 - bars);
  el.textContent = `${filled}${empty} ${pct}%`;
}

function updateTimer() {
  if (!isRecording) return;
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  document.getElementById('duration').textContent = `${String(Math.floor(elapsed/60)).padStart(2,'0')}:${String(elapsed%60).padStart(2,'0')}`;
}

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 } });
    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];

    mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
    mediaRecorder.onstop = () => {
      const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);

      const playbackDiv = document.getElementById('playback');
      playbackDiv.innerHTML = '';

      // Play + live-visualize the recording: route the <audio> element through a
      // fresh AnalyserNode so the same real oscilloscope animates to playback.
      const playBtn = document.createElement('button');
      playBtn.textContent = '▶ 재생';
      playBtn.onclick = () => playWithVisualizer(audio, playBtn);
      playbackDiv.appendChild(playBtn);

      // Real file save: download the actual captured audio to disk (.webm).
      const dlBtn = document.createElement('button');
      dlBtn.textContent = '⬇ 파일 저장';
      dlBtn.style.marginLeft = '8px';
      dlBtn.onclick = () => downloadRecording(audioBlob);
      playbackDiv.appendChild(dlBtn);

      const duration = Math.floor((Date.now() - startTime) / 1000);
      // Real measured energy: average RMS loudness over the whole take (0..1).
      const avgEnergy = ampSamples ? (ampAccum / ampSamples) : 0.4;
      const insights = generateDaVinciInsights(duration, audioBlob.size, avgEnergy);

      document.getElementById('insights').innerHTML = insights;
      document.getElementById('result').classList.remove('hidden');

      currentSession = { id: Date.now(), timestamp: new Date().toISOString(), duration, size: audioBlob.size, url: audioUrl, insights, blob: audioBlob, 'sfumato-energy': Math.round(avgEnergy*1000)/1000, peakEnergy: Math.round(ampPeak*1000)/1000 };

      // Preview this take's voiceprint right away, so the user sees the unique
      // silhouette of the voice they just captured before deciding to save it.
      extractVoiceprint(audioBlob).then(vp => {
        if (!vp) return;
        if (currentSession) currentSession.voiceprint = vp; // reuse at save time
        const pv = document.getElementById('vp-preview');
        if (pv && currentSession && currentSession.blob === audioBlob) {
          pv.classList.remove('hidden');
          drawVoiceprint(pv, vp);
        }
      });

      stream.getTracks().forEach(t => t.stop());
      // Keep the AudioContext alive (suspended) so playback can reuse it and the
      // cached MediaElementSource nodes stay valid. Disconnect the mic source.
      if (source) { try { source.disconnect(); } catch(e) {} }
      if (audioContext && audioContext.state !== 'closed') {
        try { audioContext.suspend(); } catch(e) {}
      }
    };

    mediaRecorder.start();
    isRecording = true;
    startTime = Date.now();
    ampAccum = 0; ampSamples = 0; ampPeak = 0; // reset real energy stats

    document.getElementById('rec-btn').disabled = true;
    document.getElementById('stop-btn').disabled = false;
    document.getElementById('status').textContent = '녹음 중... 목소리를 관찰하세요.';
    const pvOld = document.getElementById('vp-preview'); if (pvOld) pvOld.classList.add('hidden');

    setupAnalyser(stream);
    timerInterval = setInterval(updateTimer, 1000);

    let t = 0;
    const animate = () => {
      if (!isRecording) return;
      const frame = getAnalyserFrame(); // real waveform + spectrum this frame
      const amp = getLiveAmplitude();
      ampAccum += amp; ampSamples++; if (amp > ampPeak) ampPeak = amp; // real energy stats
      drawSfumatoWaveform(amp, t, frame && frame.freq, frame && frame.time);
      drawDetailEye(amp); // golden detail canvas
      updateEnergyReadout(amp); // live loudness meter (real RMS)
      t += 1.2;
      animationFrame = requestAnimationFrame(animate);
    };
    animate();

  } catch (err) {
    document.getElementById('status').textContent = '마이크 권한이 필요합니다.';
  }
}

function stopRecording() {
  if (mediaRecorder && isRecording) {
    mediaRecorder.stop();
    isRecording = false;
    clearInterval(timerInterval);
    cancelAnimationFrame(animationFrame);
    document.getElementById('rec-btn').disabled = false;
    document.getElementById('stop-btn').disabled = true;
    const enEl = document.getElementById('energy'); if (enEl) enEl.textContent = '--';
    document.getElementById('status').textContent = '녹음 완료. 노트북에서 다시 들어보세요.';
    setTimeout(() => { if (ctx) drawSfumatoBackground(); }, 500);
    setTimeout(drawDetailEye, 280);
  }
}

// Play an <audio> capture while animating the REAL oscilloscope from the
// played-back signal (same analyser path used for live recording). This makes
// playback visibly "the same voice" — the trace follows the actual audio.
let playbackAudioEl = null;
function playWithVisualizer(audio, btn) {
  if (isRecording) return; // never fight the live recording loop
  // If this element is already playing, toggle pause.
  if (playbackAudioEl === audio && !audio.paused) {
    audio.pause();
    if (btn) btn.textContent = '▶ 재생';
    return;
  }
  playbackAudioEl = audio;
  const ok = setupAnalyser(audio, { toDestination: true }); // real analyser on playback
  if (btn) btn.textContent = '⏸ 일시정지';

  const loop = () => {
    if (!playbackAudioEl || playbackAudioEl.paused || playbackAudioEl.ended) return;
    const frame = ok ? getAnalyserFrame() : null;
    const amp = ok ? getLiveAmplitude() : 0.3;
    drawSfumatoWaveform(amp, Date.now() * 0.06, frame && frame.freq, frame && frame.time);
    drawDetailEye(amp);
    updateEnergyReadout(amp);
    animationFrame = requestAnimationFrame(loop);
  };
  const reset = () => {
    if (btn) btn.textContent = '▶ 재생';
    cancelAnimationFrame(animationFrame);
    const enEl = document.getElementById('energy'); if (enEl) enEl.textContent = '--';
    setTimeout(() => { if (ctx) drawSfumatoBackground(); }, 400);
  };
  audio.onended = reset;
  audio.onpause = () => { if (btn && audio.ended === false) btn.textContent = '▶ 재생'; };
  audio.play().then(() => loop()).catch(e => { console.log('Playback blocked:', e.message); reset(); });
}

// Real download of the captured audio (not a fake alert). Saves the exact blob
// that was recorded, with a dated filename.
function downloadRecording(blob, name) {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url;
    a.download = name || `aether-capture-${stamp}.webm`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    const st = document.getElementById('status');
    if (st) st.textContent = '기기에 저장했습니다 (.webm).';
  } catch(e) {
    const st = document.getElementById('status');
    if (st) st.textContent = '저장 실패: ' + e.message;
  }
}

function generateDaVinciInsights(durationSec, size, avgEnergy = null) {
  const mins = (durationSec / 60).toFixed(1);
  // Real measured loudness (0..1) → a 0..10 expressive-energy figure the user
  // can actually feel matches how loud/soft they spoke. Falls back to size only
  // if no live measurement was captured.
  const energy = (avgEnergy != null
    ? (avgEnergy * 10)
    : ((size / 12000) % 8 + 2.5)).toFixed(1);
  const quality = durationSec > 50 ? '깊고 풍부한 스푸마토 울림' : '맑고 또렷한 형태';

  const obs = [
    `${mins}분간 목소리를 담았습니다. 사이사이의 멈춤은 스푸마토처럼 부드러운 여백 — 의미가 숨쉬는 자리입니다.`,
    `호흡의 결: 에너지 ~${energy}. 모든 억양이 전체와 어울리는 균형을 이룹니다.`,
    `가만히 다시 들으면 새로운 표정이 드러납니다. 노트북에 적어보세요 — 다시 들었을 때 무엇이 달라졌나요?`,
    `소리와 감정, 시간이 함께 담겼습니다. 다음엔 이걸 시각 아트나 짧은 스케치로 옮겨보세요.`
  ];
  return `📜 관찰 노트 — ${new Date().toLocaleDateString()}\n\n${obs[Math.floor(Math.random()*obs.length)]}\n\n길이: ${mins}분 • 인상: ${quality}\n다음: 내일 다시 들어보세요. 새로운 귀로 들으면 새로운 발견이 있습니다.`;
}

async function saveToNotebook() {
  if (!currentSession) return;
  // Capture the user's reflection immediately.
  const learn = prompt('이번 녹음에서 무엇을 느꼈나요? (노트북 메모)', '');
  if (learn) currentSession.learnings = (currentSession.learnings || '') + '\n• ' + learn;
  // Persist the real audio blob so Re-listen works after a page reload.
  if (currentSession.blob) {
    saveAudioBlob(currentSession.id, currentSession.blob);
    currentSession.hasAudio = true;
    // Extract the voiceprint so the notebook can show this recording's own
    // silhouette — unless the result preview already computed it (reuse).
    if (!currentSession.voiceprint) {
      const st0 = document.getElementById('status');
      if (st0) st0.textContent = '목소리 지문을 그리는 중...';
      const vp = await extractVoiceprint(currentSession.blob);
      if (vp) currentSession.voiceprint = vp;
    }
  }
  // Blob isn't JSON-serializable — strip it before storing session metadata.
  const { blob, ...persistable } = currentSession;
  sessions.unshift(persistable);
  if (sessions.length > 42) sessions.length = 42;
  localStorage.setItem('aether_sessions', JSON.stringify(sessions));
  document.getElementById('status').textContent = '노트북에 저장했습니다. 언제든 다시 들어보세요.';
  document.getElementById('result').classList.add('hidden');
  currentSession = null;
}

async function reListenAndLearn(id) {
  const s = sessions.find(x => x.id === id);
  if (!s) return;
  // Rehydrate audio: in-session blob URLs die on reload, so pull the persisted
  // blob from IndexedDB and mint a fresh URL. Then play WITH the visualizer.
  let url = s.url;
  let playable = false;
  try {
    const blob = await loadAudioBlob(id);
    if (blob) { url = URL.createObjectURL(blob); playable = true; }
    else if (s.url) { playable = true; } // still-live in-session URL
  } catch(e) {}
  if (playable && url) {
    // The visualizer animates on the main canvas, which sits above the notebook
    // list — scroll it into view so re-listening actually SHOWS the waveform
    // instead of animating off-screen.
    const viz = document.querySelector('.visualizer');
    if (viz && viz.scrollIntoView) viz.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const st = document.getElementById('status');
    if (st) st.textContent = '다시 듣는 중 — 파형을 관찰하세요.';
    const a = new Audio(url);
    playWithVisualizer(a);
  } else {
    const st = document.getElementById('status');
    if (st) st.textContent = '이 세션의 오디오는 더 이상 남아있지 않습니다 (저장 기능 이전 녹음).';
  }
  // On re-listen, add a short reflective prompt so the notebook keeps evolving.
  const days = Math.floor((Date.now() - new Date(s.timestamp)) / 864e5) || 1;
  const evolved = `\n\n[다시 듣기 +${days}일] 새로 들리는 것: ${['이제 침묵이 노래한다','억양이 달라졌다','감정의 결이 더 또렷하다'][Math.floor(Math.random()*3)]}. 무엇을 새로 발견했나요?`;
  const entry = document.createElement('div');
  entry.className = 'notebook-entry';
  entry.innerHTML = `<small>다시 들음 ${new Date().toLocaleTimeString()}</small><br>${(s.learnings || s.insights).replace(/\n/g,'<br>')}${evolved}`;
  const nb = document.querySelector('.result') || document.getElementById('result');
  if (nb) nb.appendChild(entry);
  // auto append evolved to session
  s.learnings = (s.learnings || s.insights) + evolved;
  localStorage.setItem('aether_sessions', JSON.stringify(sessions));
}

function showNotebook() {
  const list = document.createElement('div');
  list.className = 'result';
  list.innerHTML = `<h3>📓 노트북</h3><small>다시 들으면 새로운 귀로 듣게 됩니다. 달라진 점을 기록하세요.</small>`;
  if (!sessions.length) {
    list.innerHTML += '<p>먼저 녹음을 남겨보세요.</p>';
  } else {
    sessions.slice(0, 9).forEach(s => {
      const el = document.createElement('div');
      el.className = 'notebook-entry';
      const learnHtml = (s.learnings || '').replace(/\n/g, '<br>');
      // Each entry leads with this recording's own voiceprint silhouette so the
      // archive reads as a gallery of distinct voices, not identical text blocks.
      const vpId = 'vp_' + s.id;
      const vpHtml = s.voiceprint && s.voiceprint.length
        ? `<canvas id="${vpId}" width="300" height="46" class="voiceprint" title="이 녹음의 목소리 지문"></canvas>`
        : '';
      el.innerHTML = `${vpHtml}<small>${new Date(s.timestamp).toLocaleString()} • ${s.duration}s</small><br>${s.insights.replace(/\n/g,'<br>')}<br>${learnHtml}
        <br><button onclick="reListenAndLearn(${s.id})" style="font-size:0.75rem;padding:4px 8px;margin-top:6px">🔁 다시 듣기</button>`;
      list.appendChild(el);
      if (s.voiceprint && s.voiceprint.length) {
        const cnv = el.querySelector('#' + vpId);
        drawVoiceprint(cnv, s.voiceprint);
      }
    });
  }
  const old = document.getElementById('result');
  if (old) old.replaceWith(list); else document.querySelector('.container').appendChild(list);
}

function shareArtistic() {
  // Real export: save the actual recording to disk.
  if (currentSession && currentSession.blob) {
    downloadRecording(currentSession.blob);
    return;
  }
  const st = document.getElementById('status');
  if (st) st.textContent = '먼저 녹음하세요. 그러면 파일로 저장됩니다.';
}

function addAnatomyGestures() {
  // Natural gesture controls (long-press / swipe / double-tap)
  const viz = document.querySelector('.visualizer');
  if (!viz || viz._gestured) return;
  viz._gestured = true;

  // Long press = record toggle (body precision)
  let lp;
  viz.addEventListener('mousedown', () => { lp = setTimeout(() => isRecording ? stopRecording() : startRecording(), 420); });
  viz.addEventListener('mouseup', () => clearTimeout(lp));
  viz.addEventListener('mouseleave', () => clearTimeout(lp));

  // Swipe vertical on canvas = stop (anatomy flow gesture)
  let sy = 0;
  canvas.addEventListener('touchstart', e => { sy = e.touches[0].clientY; });
  canvas.addEventListener('touchend', e => {
    if (Math.abs(e.changedTouches[0].clientY - sy) > 55 && isRecording) stopRecording();
  });

  // Double tap canvas = quick notebook (dissect observation)
  canvas.addEventListener('dblclick', () => { if (!isRecording) showNotebook(); });
}

window.onload = () => {
  initCanvas();
  addAnatomyGestures();
  document.getElementById('status').textContent = '준비 완료. 이어폰으로 말해보세요.';

  document.addEventListener('keydown', e => {
    if (e.code === 'Space' && document.activeElement.tagName === 'BODY') {
      e.preventDefault();
      isRecording ? stopRecording() : startRecording();
    }
    if (e.key.toLowerCase() === 'n') showNotebook();
  });

  console.log('%cAether Canvas ready.', 'color:#c5a46e');
};
