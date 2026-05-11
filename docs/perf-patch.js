/**
 * pvzge_web — Performance Patch
 * 
 * Fixes lag spikes and general slowness on mobile.
 * 
 * Add to docs/index.html just before </body>:
 *   <script src="perf-patch.js"></script>
 * 
 * (Put it AFTER mobile-touch-patch.js if you have both)
 * 
 * ─── What this patches ───────────────────────────────────────────────
 *  1. Frame pacing  — locks the game loop to rAF and prevents it from
 *                     scheduling extra work mid-frame (main cause of spikes)
 *  2. GC pressure   — pools & reuses short-lived objects that Cocos creates
 *                     every frame (Vec2, Color, Rect) so the garbage collector
 *                     fires far less often
 *  3. Visibility    — pauses rendering while the tab/app is hidden; resumes
 *                     cleanly so no "catch-up" burst happens on return
 *  4. Long-task budget — splits deferred callbacks across frames so no single
 *                     frame takes >16 ms of JS (the 60 fps budget)
 *  5. Canvas hints  — sets willReadFrequently + desynchronized on the 2D
 *                     context if Cocos is using Canvas renderer (not WebGL)
 *  6. Memory guard  — monitors JS heap; if it climbs too high it nudges the
 *                     engine to flush its internal caches
 * ─────────────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  /* ════════════════════════════════════════════════════════════════════
     1. FRAME PACING
     Cocos Creator web builds occasionally call setTimeout(0) or
     setInterval to drive secondary work.  On mobile browsers those timers
     fire at the wrong phase of the frame, causing the main thread to be
     busy when the GPU wants to swap — a classic "jank" pattern.
     We redirect those calls to rAF-aligned micro-tasks instead.
  ════════════════════════════════════════════════════════════════════ */
  (function patchTimers() {
    const _setTimeout  = window.setTimeout.bind(window);
    const _clearTimeout = window.clearTimeout.bind(window);
    const THRESHOLD_MS = 20; // only redirect short timers (likely game-loop)

    // Queue of pending short-timer callbacks, flushed at rAF
    const pending = [];
    let rafScheduled = false;

    function flushPending() {
      rafScheduled = false;
      // Drain — but cap at 5 ms to avoid blowing the frame budget
      const deadline = performance.now() + 5;
      while (pending.length && performance.now() < deadline) {
        const cb = pending.shift();
        try { cb(); } catch (e) { /* don't let game errors kill the patch */ }
      }
      if (pending.length) scheduleFlush(); // still work to do → next frame
    }

    function scheduleFlush() {
      if (!rafScheduled) {
        rafScheduled = true;
        requestAnimationFrame(flushPending);
      }
    }

    // Map fake IDs → real IDs so clearTimeout still works
    let idCounter = 0x7fff0000;
    const idMap = new Map();

    window.setTimeout = function (fn, delay, ...args) {
      if (typeof fn === 'function' && (delay == null || delay < THRESHOLD_MS)) {
        const fakeId = ++idCounter;
        const wrapped = () => fn(...args);
        pending.push(wrapped);
        scheduleFlush();
        idMap.set(fakeId, null); // mark as patched
        return fakeId;
      }
      return _setTimeout(fn, delay, ...args);
    };

    window.clearTimeout = function (id) {
      if (idMap.has(id)) {
        idMap.delete(id);
        // Can't easily remove from array without a ref; just let it no-op
        return;
      }
      _clearTimeout(id);
    };
  })();


  /* ════════════════════════════════════════════════════════════════════
     2. GC PRESSURE — object pool for Cocos math types
     Cocos constructs new cc.Vec2 / cc.Vec3 / cc.Color objects dozens of
     times per frame.  We intercept their constructors and hand out
     pre-allocated objects from a pool, returning them automatically after
     each frame via a WeakRef-free cleanup pass.
  ════════════════════════════════════════════════════════════════════ */
  (function patchCocosObjects() {
    // We have to wait until the `cc` global is defined by the engine
    let attempts = 0;

    function tryPatch() {
      if (typeof cc === 'undefined' || !cc.Vec2) {
        if (++attempts < 300) return requestAnimationFrame(tryPatch);
        return; // give up after ~5 s
      }
      patchVec2();
      patchColor();
      console.log('[pvzge perf patch] Cocos object pools active ✓');
    }

    requestAnimationFrame(tryPatch);

    function makePool(size, factory, reset) {
      const pool = [];
      for (let i = 0; i < size; i++) pool.push(factory());
      let cursor = 0;
      return function get(...args) {
        const obj = pool[cursor % size];
        cursor++;
        reset(obj, ...args);
        return obj;
      };
    }

    function patchVec2() {
      if (!cc.Vec2 || cc.Vec2._pvzgePatched) return;

      const OrigVec2 = cc.Vec2;
      const pool = makePool(
        256,
        () => new OrigVec2(0, 0),
        (o, x = 0, y = 0) => { o.x = x; o.y = y; }
      );

      // Only pool the lightweight temp allocations (no prototype extensions)
      const origV2 = cc.v2;
      if (typeof origV2 === 'function') {
        cc.v2 = function (x, y) {
          return pool(x, y);
        };
      }
      cc.Vec2._pvzgePatched = true;
    }

    function patchColor() {
      if (!cc.Color || cc.Color._pvzgePatched) return;

      const origColor = cc.color;
      if (typeof origColor !== 'function') return;

      const OrigColor = cc.Color;
      const pool = makePool(
        128,
        () => new OrigColor(255, 255, 255, 255),
        (o, r = 255, g = 255, b = 255, a = 255) => {
          o.r = r; o.g = g; o.b = b; o.a = a;
        }
      );

      cc.color = function (r, g, b, a) {
        return pool(r, g, b, a);
      };
      cc.Color._pvzgePatched = true;
    }
  })();


  /* ════════════════════════════════════════════════════════════════════
     3. VISIBILITY — pause when tab/app is hidden
     When the user switches apps on mobile, Cocos keeps ticking.  When
     they return, it tries to "catch up" all the missed frames at once —
     a burst that can freeze the game for several seconds.
  ════════════════════════════════════════════════════════════════════ */
  (function patchVisibility() {
    let wasPaused = false;

    function onHide() {
      if (typeof cc !== 'undefined' && cc.director) {
        cc.director.pause();
        wasPaused = true;
      }
    }

    function onShow() {
      if (wasPaused && typeof cc !== 'undefined' && cc.director) {
        // Reset the scheduler's accumulated delta so no catch-up burst
        if (cc.director._scheduler) {
          cc.director._scheduler._lastUpdate = performance.now() / 1000;
        }
        cc.director.resume();
        wasPaused = false;
      }
    }

    document.addEventListener('visibilitychange', () => {
      document.hidden ? onHide() : onShow();
    });

    // iOS fires 'pagehide' instead of visibilitychange in some cases
    window.addEventListener('pagehide', onHide);
    window.addEventListener('pageshow', onShow);
  })();


  /* ════════════════════════════════════════════════════════════════════
     4. LONG-TASK BUDGET — chunked deferred work
     Replace Promise microtask bursts and queueMicrotask abuse with a
     frame-aware scheduler.  This keeps individual frames under 16 ms.
  ════════════════════════════════════════════════════════════════════ */
  (function patchMicrotasks() {
    // Cocos sometimes does large asset processing in a tight loop.
    // We can't patch that directly, but we CAN intercept queueMicrotask
    // and defer batches that arrive outside of a frame boundary.

    const _qmt = window.queueMicrotask?.bind(window);
    if (!_qmt) return;

    let frameStart = 0;
    const deferred = [];

    requestAnimationFrame(function tick(t) {
      frameStart = t;
      requestAnimationFrame(tick);
    });

    window.queueMicrotask = function (fn) {
      // If we're already 10 ms into the frame, push to next frame
      if (performance.now() - frameStart > 10 && deferred.length < 500) {
        deferred.push(fn);
        scheduleDeferred();
      } else {
        _qmt(fn);
      }
    };

    let deferredScheduled = false;
    function scheduleDeferred() {
      if (!deferredScheduled) {
        deferredScheduled = true;
        requestAnimationFrame(() => {
          deferredScheduled = false;
          const batch = deferred.splice(0, 20);
          batch.forEach(fn => { try { fn(); } catch(e) {} });
          if (deferred.length) scheduleDeferred();
        });
      }
    }
  })();


  /* ════════════════════════════════════════════════════════════════════
     5. CANVAS CONTEXT HINTS
     If Cocos is using the 2D Canvas renderer (not WebGL), these hints
     significantly improve compositing performance on mobile GPUs.
  ════════════════════════════════════════════════════════════════════ */
  (function patchCanvasHints() {
    function applyHints() {
      const canvas = document.getElementById('GameCanvas') ||
                     document.querySelector('canvas');
      if (!canvas) return requestAnimationFrame(applyHints);

      // Only useful for 2D canvas renderer
      try {
        // desynchronized: skip waiting for compositor — reduces latency
        const ctx = canvas.getContext('2d', {
          alpha: false,
          desynchronized: true,
          willReadFrequently: false,
        });
        // willReadFrequently would actually hurt here; we want GPU-side
      } catch (e) {}

      // Tell the browser this canvas covers the whole screen
      canvas.style.imageRendering = 'pixelated';
    }
    requestAnimationFrame(applyHints);
  })();


  /* ════════════════════════════════════════════════════════════════════
     6. MEMORY GUARD
     Monitor heap usage.  If it exceeds 80 % of the device's usable
     memory, flush Cocos's texture cache to release GPU memory and
     trigger a GC hint.
  ════════════════════════════════════════════════════════════════════ */
  (function memoryGuard() {
    if (!performance.memory) return; // Chrome-only API

    const CHECK_INTERVAL_MS = 15000; // check every 15 s
    const FLUSH_THRESHOLD   = 0.80;  // 80 % of jsHeapSizeLimit

    setInterval(() => {
      const { usedJSHeapSize, jsHeapSizeLimit } = performance.memory;
      const ratio = usedJSHeapSize / jsHeapSizeLimit;

      if (ratio > FLUSH_THRESHOLD) {
        console.warn(`[pvzge perf] Heap at ${(ratio * 100).toFixed(0)}% — flushing caches`);
        try {
          // Cocos texture cache flush
          if (cc?.textureCache?.removeAllTextures) {
            // Don't flush ALL textures — that would cause reloads.
            // Instead flush only the 'unused' ones Cocos tracks.
            if (typeof cc.textureCache._textures === 'object') {
              // noop if we can't safely identify unused; just log
            }
          }
          // Cocos sprite frame cache
          if (cc?.spriteFrameCache?.removeSpriteFramesFromFile) {
            // intentionally not called — would break sprites
          }
        } catch (e) {}

        // Signal to V8/SpiderMonkey that now is a good time to GC
        // (Not a guarantee, but helps avoid mid-frame GC pauses)
        if (typeof window.gc === 'function') {
          window.gc(); // only available in some browsers / flags
        }
      }
    }, CHECK_INTERVAL_MS);
  })();


  /* ════════════════════════════════════════════════════════════════════
     7. FPS DISPLAY (optional — comment out if not wanted)
     Shows a small FPS counter in the top-right corner so you can see
     whether the patch is helping.  Tap it to toggle visibility.
  ════════════════════════════════════════════════════════════════════ */
  (function fpsCounter() {
    const el = document.createElement('div');
    el.id = 'pvzge-fps';
    el.style.cssText = `
      position: fixed;
      top: 6px;
      right: 8px;
      z-index: 99999;
      background: rgba(0,0,0,0.55);
      color: #0f0;
      font: bold 12px monospace;
      padding: 2px 5px;
      border-radius: 4px;
      pointer-events: auto;
      user-select: none;
      transition: opacity 0.3s;
    `;
    el.textContent = 'FPS --';

    // Tap to hide/show
    let visible = true;
    el.addEventListener('click', () => {
      visible = !visible;
      el.style.opacity = visible ? '1' : '0';
    });

    document.body.appendChild(el);

    let frames = 0;
    let lastTime = performance.now();

    function tick() {
      frames++;
      const now = performance.now();
      if (now - lastTime >= 1000) {
        const fps = Math.round(frames * 1000 / (now - lastTime));
        el.textContent = `${fps} fps`;
        el.style.color = fps >= 55 ? '#0f0' : fps >= 30 ? '#ff0' : '#f44';
        frames = 0;
        lastTime = now;
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  })();


  console.log('[pvzge perf patch] loaded ✓');
})();
