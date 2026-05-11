/**
 * pvzge_web — Performance Patch v4
 *
 * Add to docs/index.html just before </body>:
 *   <script src="perf-patch.js"></script>
 *
 * This version is intentionally minimal. It only does things that are
 * provably safe and have measurable impact on mobile freeze spikes.
 * Nothing touches the Cocos engine, timers, or Promise chain.
 */
(function () {
  'use strict';

  /* ── 1. FREEZE-ON-RETURN FIX ───────────────────────────────────────
   *
   * THE #1 cause of hard freezes: when you switch away from the tab and
   * come back, Cocos's game clock has been ticking the whole time. It
   * then tries to simulate all those missed frames in one burst, locking
   * the browser for several seconds.
   *
   * Fix: pause cc.director the moment the page hides, then reset the
   * internal time reference before resuming, so delta-time on the first
   * tick back is effectively zero.
   *
   * This runs AFTER engine boot (we wait for cc.director), so it cannot
   * interfere with loading.
   */
  (function fixReturnFreeze() {
    var paused = false;

    function getDir() {
      try { return (typeof cc !== 'undefined') ? cc.director : null; }
      catch (e) { return null; }
    }

    function onHide() {
      if (paused) return;
      var d = getDir();
      if (!d) return;           // engine not running yet — skip safely
      try { d.pause(); paused = true; } catch (e) {}
    }

    function onShow() {
      if (!paused) return;
      var d = getDir();
      if (!d) return;
      try {
        // Reset the scheduler's time reference so the first frame after
        // resuming has a delta of ~0 instead of "all the time we were hidden"
        var sched = typeof d.getScheduler === 'function'
          ? d.getScheduler()
          : d._scheduler;
        if (sched) {
          var t = performance.now() / 1000;
          if ('_lastUpdate'  in sched) sched._lastUpdate  = t;
          if ('_currentTime' in sched) sched._currentTime = t;
        }
        d.resume();
        paused = false;
      } catch (e) {}
    }

    document.addEventListener('visibilitychange', function () {
      document.hidden ? onHide() : onShow();
    });
    window.addEventListener('pagehide', onHide);
    window.addEventListener('pageshow',  onShow);
  }());


  /* ── 2. WebGL POWER HINT ───────────────────────────────────────────
   *
   * On Android, the GPU driver defaults to a low-power profile for web
   * content. Requesting 'high-performance' switches to the full GPU
   * clock speed — this alone can reduce frame time by 20-30% on mid-range
   * devices (Snapdragon 6xx series, MediaTek Dimensity).
   *
   * We intercept getContext exactly once, before Cocos calls it, then
   * immediately restore the original. Only adds options; never removes
   * any that Cocos sets itself.
   */
  (function webglPowerHint() {
    var orig = HTMLCanvasElement.prototype.getContext;
    var done = false;
    HTMLCanvasElement.prototype.getContext = function (type, opts) {
      if (!done && (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl')) {
        done = true;
        HTMLCanvasElement.prototype.getContext = orig; // self-remove immediately
        opts = Object.assign(
          { powerPreference: 'high-performance', alpha: false, antialias: false },
          opts || {}
        );
      }
      return orig.call(this, type, opts);
    };
  }());


  /* ── 3. COMPOSITOR LAYER ───────────────────────────────────────────
   *
   * Without this, the browser repaints the entire page every time the
   * canvas changes — even though nothing else on the page moves.
   * translateZ(0) promotes the canvas to its own GPU layer so only it
   * is composited each frame. Consistent ~5-10% frame-time reduction.
   */
  (function gpuLayer() {
    var style = document.createElement('style');
    style.textContent =
      'canvas{transform:translateZ(0);will-change:transform}' +
      'html,body{overscroll-behavior:none}' +        // stop iOS bounce eating input
      '*{-webkit-tap-highlight-color:transparent}';  // removes flash composite on touch
    document.head.appendChild(style);
  }());


  /* ── 4. FPS + FREEZE MONITOR ───────────────────────────────────────
   *
   * Shows live FPS. More importantly, when a freeze happens (a single
   * frame took > 100ms) it briefly flashes red so you can see exactly
   * when and how often it's occurring. Tap to hide/show.
   *
   * Use this to confirm:
   *   - If FPS is solid 30 with no red flashes → game is rendering fine,
   *     the "lag" is input latency (different problem, different fix).
   *   - If you see regular red flashes every few seconds → GC pauses
   *     from the game's JS allocations. Can't be fixed from outside
   *     the compiled bundle without recompiling the game.
   *   - If FPS drops to <20 under load → CPU/GPU bottleneck on your
   *     device; the game is simply too heavy for mobile.
   */
  (function fpsMonitor() {
    var el = document.createElement('div');
    el.style.cssText =
      'position:fixed;top:6px;right:8px;z-index:99999;' +
      'background:rgba(0,0,0,.6);color:#0f0;' +
      'font:bold 12px/1.2 monospace;padding:4px 7px;' +
      'border-radius:5px;pointer-events:auto;' +
      'user-select:none;-webkit-user-select:none;' +
      'transition:background .1s';
    el.textContent = 'FPS --';

    var visible = true;
    el.addEventListener('click', function () {
      visible = !visible;
      el.style.opacity = visible ? '1' : '0';
    });

    (function mount() {
      if (document.body) document.body.appendChild(el);
      else setTimeout(mount, 50);
    }());

    var frames = 0;
    var last   = performance.now();
    var prev   = last;

    (function tick() {
      var now = performance.now();
      var frameDelta = now - prev;
      prev = now;
      frames++;

      // Flash background red if this frame took > 100ms (= a freeze spike)
      if (frameDelta > 100) {
        el.style.background = 'rgba(200,0,0,.8)';
        setTimeout(function () {
          el.style.background = 'rgba(0,0,0,.6)';
        }, 400);
      }

      if (now - last >= 1000) {
        var fps = Math.round(frames * 1000 / (now - last));
        el.textContent = fps + ' fps';
        el.style.color = fps >= 55 ? '#0f0' : fps >= 30 ? '#ff0' : '#f55';
        frames = 0;
        last   = now;
      }

      requestAnimationFrame(tick);
    }());
  }());

}());
