// golden-detail.js — Golden-ratio detail accent for the voice visualizer.
// Draws a soft, sfumato-glazed "eye" shape at the canvas's 0.618 point that
// reacts subtly to the voice. Purely visual — no data leaves this file.
// Usage: window.drawGoldenDetail(ctx, width, centerY, detail, amplitude)

(function() {
  'use strict';

  function drawGoldenEye(ctx, width, centerY, motion, amplitude) {
    // 0.618 golden point of the canvas
    const gx = width * 0.618;
    const phase = (motion && motion.phase) || 0;
    const gy = centerY + phase * 3; // drifts gently with the voice

    // A little liveliness scales the eye with loudness.
    const react = Math.min(1, amplitude * 1.2);
    const eyeSize = 8 + react * 14;
    const alpha = 0.12 + react * 0.14;

    // Sfumato multi-glaze eye (soft, no hard edges)
    for (let g = 0; g < 5; g++) {
      const s = eyeSize * (1 + g * 0.18);
      const a = alpha * (1 - g * 0.18);
      ctx.strokeStyle = `hsla(42, 65%, 78%, ${a})`;
      ctx.lineWidth = 1.2 - g * 0.15;
      ctx.shadowBlur = 6 + react * 4;
      ctx.shadowColor = `hsla(42, 80%, 85%, 0.3)`;
      ctx.beginPath();
      ctx.ellipse(gx, gy, s * 1.1, s * 0.55, phase * 0.3, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Iris
    const irisR = eyeSize * 0.45 * (0.7 + react * 0.6);
    ctx.strokeStyle = `rgba(197,164,110, ${0.35 + react * 0.25})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(gx, gy, irisR, 0, Math.PI * 2);
    ctx.stroke();

    // Pupil — the "seeing" point
    const pupilR = irisR * (0.35 + react * 0.25);
    ctx.fillStyle = `rgba(42, 32, 18, ${0.6 + react * 0.3})`;
    ctx.beginPath();
    ctx.arc(gx + (react - 0.5) * 1.5, gy, pupilR, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowBlur = 0;
  }

  // Main exported hook (called from the visualizer draw loop).
  window.drawGoldenDetail = function(ctx, width, centerY, motion, amplitude) {
    if (!ctx) return;
    drawGoldenEye(ctx, width, centerY, motion || { phase: 0 }, amplitude || 0);
  };

  console.log('%c[Aether] golden detail ready.', 'color:#c5a46e');
})();
