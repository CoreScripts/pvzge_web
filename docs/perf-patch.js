/**
 * pvzge_web — Performance Patch v2
 *
 * Fixes lag spikes on mobile without breaking the game boot sequence.
 *
 * Add to docs/index.html just before </body>:
 *   <script src="perf-patch.js"></script>
 * (Put it AFTER mobile-touch-patch.js if you have both)
 *
 * ─── What this patches ───────────────────────────────────────────────
 *  1. Visibility pause  — stops the engine when you switch apps so it
 *                         doesn't burst-catch-up when you return
 *  2. Canvas GPU hints  — tells the browser to keep canvas pixels on the
 *                         GPU and skip the compositor wait (lower latency)
 *  3. Memory guard      — checks heap every 15 s; if high, nudges GC to
 *                         fire between frames instead of mid-frame
 *  4. CSS rendering     — disables expensive filters/transitions on body
 *                         that some mobile browsers apply by default
 *  5. FPS counter       — live fps display; tap to hide
 * ─────────────────────────────────────────────────────────────────────
 *
 * Patches that were REMOVED vs v1 (they broke the boot screen):
 *   ✗ setTimeout redirect  — Cocos's asset loader chains on setTimeout(0)
 *   ✗ queueMicrotask patch — Cocos Promises resolve the scene graph
 *   ✗ cc.v2 / cc.color pools — pooled objects got aliased & corrupted state
 */

(function () {
  'use strict';

  /* ════════════════════════════════════════════════════════════════════
     1. VISIBILITY — pause engine when tab/app goes to background
     Root cause of the worst lag spikes: Cocos keeps its game clock
     ticking while the app is hidden. On return it tries to simulate all
     the missed time at once — a multi-second freeze. We stop the clock
     the moment the page is hidden and reset it cleanly on resume.
  ════════════════════════════════════════════════════════════════════ */
  (function patchVisibility() {
    // Wait for cc.director to exist before registering
    let registered = false;

    function tryRegister() {
      if (typeof cc === 'undefined' || !cc.director) {
        return requestAnimationFrame(tryRegister);
      }
      if (registered) return;
      registered = true;

      let hidden = false;

      function onHide() {
        if (hidden) return;
        hidden = true;
        try { cc.director.pause(); } catch (e) {}
      }

      function onShow() {
        if (!hidden) return;
        hidden = false;
        try {
          // Reset the scheduler's last-update timestamp so delta = 0
          // on the first tick back — no catch-up burst
          const sched = cc.director._scheduler || cc.director.getScheduler?.();
          if (sched) {
            // Cocos 2.x stores _lastUpdate in seconds
            if ('_lastUpdate' in sched) sched._lastUpdate = performance.now() / 1000;
            // Cocos Creator 3.x uses _startTime
            if ('_startTime' in sched) sched._startTime = performance.now();
          }
          cc.director.resume();
        } catch (e) {}
      }

      document.addEventListener('visibilitychange', () => {
        document.hidden ? onHide() : onShow();
      });
      window.addEventListener('pagehide',  onHide);  // iOS Safari
      window.addEventListener('pageshow',  onShow);
      window.addEventListener('blur',      onHide);  // Android Chrome background
      window.addEventListener('focus',     onShow);

      console.log('[pvzge perf] visibility patch active ✓');
    }

    requestAnimationFrame(tryRegister);
  })();


  /* ════════════════════════════════════════════════════════════════════
     2. CANVAS GPU HINTS
     Two browser hints that together cut input-to-pixel latency on mobile:
     • alpha:false        — browser skips blending the canvas over the page
     • desynchronized     — canvas swaps independently of the compositor;
                            removes one full frame of pipeline latency
     These are set as getContext() options, which only work if called
     BEFORE Cocos calls getContext itself.  We use a Proxy on
     HTMLCanvasElement.prototype.getContext to intercept the first call.
  ════════════════════════════════════════════════════════════════════ */
  (function patchCanvasContext() {
    const _getContext = HTMLCanvasElement.prototype.getContext;
    let applied = false;

    HTMLCanvasElement.prototype.getContext = function (type, opts) {
      if (!applied && (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl')) {
        applied = true;
        // Merge in our hints without overriding anything Cocos explicitly set
        opts = Object.assign({
          alpha: false,
          desynchronized: true,
          powerPreference: 'high-performance',
          antialias: false,       // mobile GPUs pay a real cost for MSAA
          preserveDrawingBuffer: false,
        }, opts || {});
        console.log('[pvzge perf] WebGL context hints applied ✓');
      } else if (!applied && type === '2d') {
        applied = true;
        opts = Object.assign({ alpha: false, desynchronized: true }, opts || {});
        console.log('[pvzge perf] Canvas2D context hints applied ✓');
      }
      return _getContext.call(this, type, opts);
    };
  })();


  /* ════════════════════════════════════════════════════════════════════
     3. MEMORY GUARD
     GC pauses mid-frame are the #1 cause of random lag spikes on
     Android.  We can't prevent GC, but we can move it to between frames
     by monitoring heap size and calling a no-op allocation burst at
     frame-end — this nudges V8 to collect now rather than during a
     hot gameplay moment.
     Falls back gracefully on browsers without performance.memory.
  ════════════════════════════════════════════════════════════════════ */
  (function memoryGuard() {
    const CHECK_INTERVAL_MS = 10000;
    const WARN_THRESHOLD    = 0.75; // 75 % of jsHeapSizeLimit

    // Between-frame GC nudge: allocate a throwaway typed array then
    // immediately null it.  This makes the GC "notice" there's pressure
    // at a safe moment (between rAF callbacks).
    function nudgeGC() {
      requestAnimationFrame(() => {
        try {
          // A 1 MB allocation is enough to make V8 check GC thresholds
          let dummy = new Uint8Array(1024 * 1024);
          dummy = null;
        } catch (e) {}
      });
    }

    if (performance.memory) {
      setInterval(() => {
        const { usedJSHeapSize, jsHeapSizeLimit } = performance.memory;
        const ratio = usedJSHeapSize / jsHeapSizeLimit;
        if (ratio > WARN_THRESHOLD) {
          console.warn(`[pvzge perf] Heap ${(ratio * 100).toFixed(0)}% full — nudging GC`);
          nudgeGC();
        }
      }, CHECK_INTERVAL_MS);
    } else {
      // No memory API — nudge on a fixed schedule as a precaution
      setInterval(nudgeGC, 30000);
    }
  })();


  /* ════════════════════════════════════════════════════════════════════
     4. CSS RENDERING OPTIMISATIONS
     Mobile browsers sometimes apply GPU-expensive default styles to
     the document.  Force the known-fast path.
  ════════════════════════════════════════════════════════════════════ */
  (function cssHints() {
    const style = document.createElement('style');
    style.textContent = `
      /* Promote canvas to its own compositor layer — avoids repaints
         caused by DOM changes elsewhere on the page */
      canvas {
        will-change: contents;
        transform: translateZ(0);
        backface-visibility: hidden;
        -webkit-backface-visibility: hidden;
      }

      /* Prevent the browser's text-size-adjust from triggering layout */
      html {
        -webkit-text-size-adjust: none;
        text-size-adjust: none;
      }

      /* Kill any default tap highlight flash (saves a composite on every touch) */
      * {
        -webkit-tap-highlight-color: transparent;
      }
    `;
    document.head.appendChild(style);
  })();


  /* ════════════════════════════════════════════════════════════════════
     5. FPS COUNTER
     Shows live FPS in the top-right corner.
     Green ≥ 55 fps  |  Yellow ≥ 30  |  Red < 30
     Tap to hide/show.
  ════════════════════════════════════════════════════════════════════ */
  (function fpsCounter() {
    const el = document.createElement('div');
    el.style.cssText = `
      position: fixed;
      top: 6px; right: 8px;
      z-index: 99999;
      background: rgba(0,0,0,0.55);
      color: #0f0;
      font: bold 12px/1 monospace;
      padding: 3px 6px;
      border-radius: 4px;
      pointer-events: auto;
      user-select: none;
      letter-spacing: 0.5px;
    `;
    el.textContent = 'FPS --';

    let show = true;
    el.addEventListener('click', () => {
      show = !show;
      el.style.opacity = show ? '1' : '0';
    });

    document.body.appendChild(el);

    let frames = 0, last = performance.now();

    (function tick() {
      frames++;
      const now = performance.now();
      if (now - last >= 1000) {
        const fps = Math.round(frames * 1000 / (now - last));
        el.textContent = `${fps} fps`;
        el.style.color = fps >= 55 ? '#0f0' : fps >= 30 ? '#ff0' : '#f55';
        frames = 0;
        last = now;
      }
      requestAnimationFrame(tick);
    })();
  })();


  console.log('[pvzge perf patch v2] loaded ✓');
})();
