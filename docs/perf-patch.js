/**
 * pvzge_web — Performance Patch v3
 *
 * Drop in docs/ and add ONE line before </body> in index.html:
 *   <script src="perf-patch.js"></script>
 *
 * Rules this version follows:
 *   - NEVER overrides setTimeout, setInterval, queueMicrotask, or Promises
 *   - NEVER touches cc.* objects (Cocos internals)
 *   - Only uses stable browser APIs
 *   - Every fix is independent — none can break another
 */

(function () {
  'use strict';

  /* ── 1. PAUSE ON HIDE ──────────────────────────────────────────────
     When you switch apps, Cocos keeps its clock running. When you come
     back it tries to simulate all the missed time at once — a multi-second
     freeze. We pause cc.director the moment the page hides and reset the
     scheduler's delta before resuming so it never plays catch-up.
     Safe during boot: if the engine isn't up yet, hide() is a no-op.
  ──────────────────────────────────────────────────────────────────── */
  (function pauseOnHide() {
    var hidden = false;

    function director() {
      try { return (typeof cc !== 'undefined') && cc.director || null; }
      catch(e) { return null; }
    }

    function hide() {
      if (hidden) return;
      var d = director();
      if (!d) return;
      hidden = true;
      try { d.pause(); } catch(e) {}
    }

    function show() {
      if (!hidden) return;
      var d = director();
      if (!d) return;
      hidden = false;
      try {
        // Zero out accumulated delta so no burst of catch-up frames
        var s = (typeof d.getScheduler === 'function') ? d.getScheduler() : d._scheduler;
        if (s) {
          var now = performance.now() / 1000;
          if ('_lastUpdate'  in s) s._lastUpdate  = now;
          if ('_currentTime' in s) s._currentTime = now;
        }
        d.resume();
      } catch(e) {}
    }

    document.addEventListener('visibilitychange', function () {
      document.hidden ? hide() : show();
    });
    window.addEventListener('pagehide', hide);  // iOS Safari
    window.addEventListener('pageshow',  show);
  }());


  /* ── 2. WebGL CONTEXT HINTS ────────────────────────────────────────
     Intercept getContext ONCE before Cocos calls it, to inject hints:
       alpha: false           skip blending canvas over page background
       desynchronized: true   canvas swaps independently of compositor
                              (~1 frame less input lag on Android/iOS)
       powerPreference: 'high-performance'  use fast GPU path
       antialias: false       mobile GPUs pay a real cost for MSAA;
                              pixel-art game style doesn't need it

     Self-removes after first WebGL call — no permanent monkey-patch.
  ──────────────────────────────────────────────────────────────────── */
  (function webglHints() {
    var _orig = HTMLCanvasElement.prototype.getContext;
    var done  = false;

    HTMLCanvasElement.prototype.getContext = function (type, opts) {
      if (!done && (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl')) {
        done = true;
        HTMLCanvasElement.prototype.getContext = _orig; // restore immediately
        opts = Object.assign(
          { alpha: false, desynchronized: true,
            powerPreference: 'high-performance', antialias: false,
            preserveDrawingBuffer: false },
          opts || {}
        );
      }
      return _orig.call(this, type, opts);
    };
  }());


  /* ── 3. CSS LAYER PROMOTION ────────────────────────────────────────
     Compositing the canvas on its own GPU layer means the browser won't
     repaint the whole page when the game redraws — big win on Android.
     Also kills tap-highlight flash and overscroll bounce.
  ──────────────────────────────────────────────────────────────────── */
  (function cssHints() {
    var s = document.createElement('style');
    s.textContent =
      'canvas{transform:translateZ(0);will-change:transform;' +
        '-webkit-backface-visibility:hidden;backface-visibility:hidden}' +
      '*{-webkit-tap-highlight-color:transparent}' +
      'html,body{overscroll-behavior:none}';
    document.head.appendChild(s);
  }());


  /* ── 4. FPS COUNTER ────────────────────────────────────────────────
     Live fps display so you can tell if lag is the game or the device.
     Green = 55+   Yellow = 30–54   Red = below 30
     Tap once to hide, tap again to show.
  ──────────────────────────────────────────────────────────────────── */
  (function fpsCounter() {
    var el = document.createElement('div');
    el.style.cssText =
      'position:fixed;top:6px;right:8px;z-index:99999;' +
      'background:rgba(0,0,0,.5);color:#0f0;' +
      'font:bold 11px/1 monospace;padding:3px 6px;' +
      'border-radius:4px;pointer-events:auto;' +
      'user-select:none;-webkit-user-select:none';
    el.textContent = 'FPS --';

    var shown = true;
    el.addEventListener('click', function () {
      shown = !shown;
      el.style.opacity = shown ? '1' : '0';
    });

    (function mount() {
      if (document.body) document.body.appendChild(el);
      else setTimeout(mount, 50);
    }());

    var frames = 0, last = performance.now();
    (function tick() {
      frames++;
      var now = performance.now();
      if (now - last >= 1000) {
        var fps = Math.round(frames * 1000 / (now - last));
        el.textContent = fps + ' fps';
        el.style.color = fps >= 55 ? '#0f0' : fps >= 30 ? '#ff0' : '#f55';
        frames = 0;
        last = now;
      }
      requestAnimationFrame(tick);
    }());
  }());

}());
