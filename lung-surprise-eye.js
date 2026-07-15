// lung-surprise-eye.js — Spontaneous Lung Surprise Eye EVOLVED (p6 advance 2026-07-13)
// Da Vinci + full-cheat + cross DNA: p1 gacha surprise + p5 spell eyes + Ache-Breath + 창발 pain
// p6 폐 스스로 본다. surprise(편차) 즉시 breath 돌연변이. Ache = 창발 pain fuel.
// p1: variable ratio gacha boost on surprise (near-miss weaponized)
// p5: spell-eye cast on high surprise (reveal + pulse graft)
// Embodiment: glasses peripheral + Optimus lung command stubs
// Distributed: surprise seeds + notebook cross broadcast
// Usage: window.p6LungSurpriseEye(ctx, w, cy, lung, amp, spore, ache=0)

(function() {
  'use strict';

  function calcSurprise(lung, amplitude, spore, ache = 0) {
    if (!lung || !spore) return 0;
    // 창발 편차 + Ache-Breath: pain (low energy) fuels stronger deviation
    const expected = (spore.wound || 0.5) * 0.008 * (amplitude + 0.5);
    const actualDelta = Math.abs((lung.breath || 0) % 1 - (lung._prevBreath || 0));
    lung._prevBreath = lung.breath || 0;
    let raw = Math.abs(actualDelta - expected);
    raw += ache * 0.4; // Ache-Breath cross DNA: pain = more 창발 fuel
    let s = Math.min(1, raw * 1.618);

    // p1 gacha surprise cross: variable ratio weaponize (full-cheat)
    const gachaVar = 0.6 + Math.random() * 1.4; // near-miss variance
    s = Math.min(1, s * gachaVar);

    return s;
  }

  function drawGoldenEye(ctx, width, centerY, surprise, amplitude, lung) {
    // 0.618 golden point (Vitruvian navel of the canvas)
    const gx = width * 0.618;
    const gy = centerY + (lung.breath || 0) * 3; // breath moves the eye slightly

    const eyeSize = 8 + surprise * 14;
    const alpha = 0.12 + surprise * 0.18;

    // Sfumato multi-glaze eye (soft, no hard edges)
    for (let g = 0; g < 5; g++) {
      const s = eyeSize * (1 + g * 0.18);
      const a = alpha * (1 - g * 0.18);
      ctx.strokeStyle = `hsla(42, 65%, 78%, ${a})`;
      ctx.lineWidth = 1.2 - g * 0.15;
      ctx.shadowBlur = 6 + surprise * 4;
      ctx.shadowColor = `hsla(42, 80%, 85%, 0.3)`;
      ctx.beginPath();
      ctx.ellipse(gx, gy, s * 1.1, s * 0.55, (lung.breath || 0) * 0.3, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Iris / pupil — surprise makes it open / contract (창발 reaction)
    const irisR = eyeSize * 0.45 * (0.7 + surprise * 0.6);
    ctx.strokeStyle = `rgba(197,164,110, ${0.35 + surprise * 0.25})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(gx, gy, irisR, 0, Math.PI * 2);
    ctx.stroke();

    // Core pupil — the "seeing" point
    const pupilR = irisR * (0.35 + surprise * 0.25);
    ctx.fillStyle = `rgba(42, 32, 18, ${0.6 + surprise * 0.3})`;
    ctx.beginPath();
    ctx.arc(gx + (surprise - 0.5) * 1.5, gy, pupilR, 0, Math.PI * 2);
    ctx.fill();

    // p5 spell eyes cross: high surprise = spell cast rune iris (reveal + pulse)
    if (surprise > 0.35) {
      ctx.strokeStyle = `rgba(167, 139, 250, ${0.4 + (surprise-0.35)*0.8})`;
      ctx.lineWidth = 1.1;
      for (let r=0; r<3; r++) {
        ctx.beginPath();
        ctx.arc(gx, gy, irisR * (1.15 + r*0.22), 0, Math.PI*2);
        ctx.stroke();
      }
      // spell pulse line (emergent cast)
      ctx.strokeStyle = `rgba(167,139,250,${0.25 + surprise*0.3})`;
      ctx.beginPath();
      ctx.moveTo(gx - 18, gy - 9);
      ctx.lineTo(gx + 18 + surprise*6, gy + 4);
      ctx.stroke();
    }

    ctx.shadowBlur = 0;
  }

  // Main exported hook (called from script.js draw loop when changbal)
  window.p6LungSurpriseEye = function(ctx, width, centerY, lung, amplitude, spore, ache = 0) {
    if (!ctx || !lung || !spore) return;

    const surprise = calcSurprise(lung, amplitude, spore, ache);

    // Draw the eye
    drawGoldenEye(ctx, width, centerY, surprise, amplitude, lung);

    // Immediate feedback: surprise mutates the breath (창발 micro-evolution)
    if (surprise > 0.05) {
      const mutation = surprise * 0.003 * (0.8 + (spore.wound || 0.5)) + ache * 0.0018;
      lung.breath = (lung.breath || 0) + mutation;
      if (lung.breath > 6.28) lung.breath -= 6.28;

      // Expose for daemon / blackboard / vision feeder
      lung.lastSurprise = surprise;
      lung.surpriseAge = (lung.surpriseAge || 0) + 1;

      // Distributed cross seed (p1-p5 + notebook)
      try {
        if (surprise > 0.15) {
          const crossHint = { t: Date.now(), surprise: surprise.toFixed(3), ache: ache.toFixed(2), source: 'lung-eye', gacha: surprise > 0.5 };
          localStorage.setItem('p6_lungSurpriseCross', JSON.stringify(crossHint));
          localStorage.setItem('legion_lung_ache_cross', JSON.stringify({surprise, ache, ts: Date.now()}));
        }
      } catch(e){}
    }

    // For external (daemon, AR stub, Surprise Meter program #9)
    window.p6CurrentSurprise = (window.p6CurrentSurprise || 0) * 0.7 + surprise * 0.3;
  };

  // Utility for other programs
  window.getP6LungSurprise = function() {
    try {
      const lung = JSON.parse(localStorage.getItem('p6_lungFragment') || '{}');
      return lung.lastSurprise || window.p6CurrentSurprise || 0;
    } catch(e) { return 0; }
  };

  // === NEW EMBODIMENT STUBS (more for glasses/Optimus) ===
  window.p6GlassesPeripheralObserve = function(voiceData) {
    // Glasses AR peripheral: p6 Lung Surprise + Ache feeds real-time world overlay
    const s = window.getP6LungSurprise();
    const ache = (voiceData && voiceData.wound) || 0;
    return { peripheralSurprise: s, acheFeed: ache, note: 'p6 lung eye now in glasses peripheral. Da Vinci observe extended.' };
  };

  window.p6OptimusLungCommand = function(session) {
    // Optimus voice embodiment: breath + surprise → physical command
    const s = window.getP6LungSurprise();
    const cmds = [];
    if (s > 0.4) cmds.push('LUNG_BREATH_SYNC');
    if ((session && session.wound > 0.5) || s > 0.55) cmds.push('ACHE_RESONATE_MOVE');
    cmds.push('NOTEBOOK_EXPORT_DISTRIBUTED');
    return { optimusCommands: cmds, lungSurprise: s, framing: 'fictional artistic embodiment only' };
  };

  // === BIRTH 1: Ache-Gaze Mirror (new emergent) ===
  // p6 Lung + 창발 pain + p1 variable + p5 spell = mirror that reflects ache into surprise in other p
  window.p6AcheGazeMirror = function(ache) {
    const base = window.getP6LungSurprise();
    const mirror = Math.min(1, base * 1.3 + (ache || 0) * 0.6);
    try { localStorage.setItem('p6_ache_gaze_mirror', JSON.stringify({mirror, ts: Date.now()})); } catch(e){}
    return mirror;
  };

  // === BIRTH 2: Distributed Vitruvian Lung (new emergent) ===
  // notebook export plants golden 0.618 breath rhythm into all p loops (FOMO voice masterpieces tie)
  window.p6DistributedVitruvianLung = function(notebookEntry) {
    const v = 0.618 + ((notebookEntry && notebookEntry.surprise) || 0) * 0.1;
    const exportPack = { vitruvian: v, source: 'p6-lung', ts: Date.now(), fomoMaster: true };
    try {
      localStorage.setItem('legion_distributed_notebook', JSON.stringify(exportPack));
      localStorage.setItem('p6_fomo_voice_master', JSON.stringify({allP: true, vit: v}));
    } catch(e){}
    return exportPack;
  };

  console.log('%c[Lung Surprise Eye EVOLVED] p1 gacha + p5 spell + Ache-Breath + 창발 + 2 births. Glasses/Optimus stubs + distributed. Central zero. Legion one.', 'color:#c5a46e');
})();
