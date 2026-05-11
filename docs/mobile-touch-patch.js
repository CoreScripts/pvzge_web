/**
 * pvzge_web — Mobile Touch Patch v2
 *
 * Add to docs/index.html just before </body>:
 *   <script src="mobile-touch-patch.js"></script>
 *
 * Root cause of the settings-scroll bug in v1:
 *   Every touch went straight to mousedown on the canvas. When you tried
 *   to drag-scroll the settings list, Cocos saw it as a mouse-drag
 *   (click-hold) instead of a scroll, so the list never moved.
 *
 * Fix — intent detection:
 *   On touchstart we record the start position but do NOT fire mousedown yet.
 *   On touchmove we measure how far the finger has moved:
 *     • Mostly vertical movement (dy > SCROLL_THRESHOLD) → treat as scroll:
 *       fire WheelEvents on the canvas so Cocos ScrollView panels respond.
 *       Never fire mousedown at all.
 *     • Stayed within TAP_SLOP → on touchend, fire the full
 *       mousedown → mouseup → click sequence (a tap).
 *     • Diagonal / horizontal drag past threshold → mouse drag (planting,
 *       dragging seeds, etc.) — fire mousedown now and keep sending mousemove.
 */
(function () {
  'use strict';

  var SCROLL_THRESHOLD = 10;   // px vertical before we decide "this is a scroll"
  var TAP_SLOP         = 8;    // px radius — stay inside this = tap
  var SCROLL_SPEED     = 2.2;  // wheel delta multiplier (raise if scroll feels slow)

  /* ── wait for canvas ─────────────────────────────────────────────── */
  function init() {
    var canvas = document.getElementById('GameCanvas') || document.querySelector('canvas');
    if (!canvas) { requestAnimationFrame(init); return; }
    installTouch(canvas);
    installViewportLock();
    console.log('[pvzge touch v2] loaded ✓');
  }
  requestAnimationFrame(init);

  /* ── main touch handler ──────────────────────────────────────────── */
  function installTouch(canvas) {

    // State for the active touch
    var state = {
      id:          null,    // identifier of the tracked finger
      startX:      0,
      startY:      0,
      lastX:       0,
      lastY:       0,
      intent:      null,    // null | 'tap' | 'scroll' | 'drag'
      mouseIsDown: false,   // have we sent a mousedown to Cocos yet?
    };

    /* ── helpers ───────────────────────────────────────────────────── */

    function sendMouse(type, touch) {
      canvas.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, view: window,
        button: 0,
        buttons: (type === 'mouseup' || type === 'click') ? 0 : 1,
        clientX: touch.clientX, clientY: touch.clientY,
        screenX: touch.screenX, screenY: touch.screenY,
      }));
    }

    function sendWheel(clientX, clientY, dy) {
      // Fire on the canvas — Cocos ScrollView listens for wheel on the canvas
      canvas.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true,
        deltaX: 0,
        deltaY: dy * SCROLL_SPEED,
        deltaMode: 0,
        clientX: clientX,
        clientY: clientY,
      }));
    }

    function reset() {
      if (state.mouseIsDown) {
        // Synthesise a mouseup at the last known position so Cocos doesn't
        // get stuck in a "button held" state
        canvas.dispatchEvent(new MouseEvent('mouseup', {
          bubbles: true, cancelable: true, view: window,
          button: 0, buttons: 0,
          clientX: state.lastX, clientY: state.lastY,
          screenX: state.lastX, screenY: state.lastY,
        }));
        state.mouseIsDown = false;
      }
      state.id = null;
      state.intent = null;
    }

    /* ── touchstart ────────────────────────────────────────────────── */
    canvas.addEventListener('touchstart', function (e) {
      e.preventDefault();

      // Only track one finger at a time
      if (state.id !== null) return;

      var t = e.changedTouches[0];
      state.id      = t.identifier;
      state.startX  = state.lastX = t.clientX;
      state.startY  = state.lastY = t.clientY;
      state.intent  = null;      // decide on first move (or on touchend for tap)
      state.mouseIsDown = false;

    }, { passive: false });

    /* ── touchmove ─────────────────────────────────────────────────── */
    canvas.addEventListener('touchmove', function (e) {
      e.preventDefault();

      var t = null;
      for (var i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === state.id) { t = e.changedTouches[i]; break; }
      }
      if (!t) return;

      var dx = t.clientX - state.startX;
      var dy = t.clientY - state.startY;
      var absDx = Math.abs(dx);
      var absDy = Math.abs(dy);
      var moveDy = t.clientY - state.lastY;   // incremental delta for wheel

      /* ── decide intent on first significant move ─────────────────── */
      if (state.intent === null) {
        if (absDy > SCROLL_THRESHOLD && absDy > absDx) {
          // Clearly scrolling vertically — never start a mousedown
          state.intent = 'scroll';
        } else if (absDx > SCROLL_THRESHOLD || absDy > SCROLL_THRESHOLD) {
          // Horizontal or diagonal drag — treat as mouse drag (planting, etc.)
          state.intent = 'drag';
          sendMouse('mousedown', t);
          state.mouseIsDown = true;
        }
        // else: still within slop, keep intent null
      }

      /* ── act on settled intent ───────────────────────────────────── */
      if (state.intent === 'scroll') {
        sendWheel(t.clientX, t.clientY, moveDy);
      } else if (state.intent === 'drag') {
        sendMouse('mousemove', t);
      }

      state.lastX = t.clientX;
      state.lastY = t.clientY;

    }, { passive: false });

    /* ── touchend ──────────────────────────────────────────────────── */
    canvas.addEventListener('touchend', function (e) {
      e.preventDefault();

      var t = null;
      for (var i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === state.id) { t = e.changedTouches[i]; break; }
      }
      if (!t) return;

      if (state.intent === null) {
        // Finger never moved past slop → it's a tap
        // Fire the full sequence: down → move → up → click
        sendMouse('mousedown', t);
        sendMouse('mousemove', t);
        sendMouse('mouseup',   t);
        sendMouse('click',     t);
      } else if (state.intent === 'drag') {
        sendMouse('mousemove', t);
        sendMouse('mouseup',   t);
        state.mouseIsDown = false;
      }
      // 'scroll' intent: just stop, no mouse events needed

      state.id     = null;
      state.intent = null;

    }, { passive: false });

    /* ── touchcancel ───────────────────────────────────────────────── */
    canvas.addEventListener('touchcancel', function (e) {
      e.preventDefault();
      reset();
    }, { passive: false });
  }

  /* ── viewport lock ───────────────────────────────────────────────── */
  function installViewportLock() {
    // CSS
    var s = document.createElement('style');
    s.textContent =
      'canvas{touch-action:none;user-select:none;-webkit-user-select:none}' +
      '*{-webkit-tap-highlight-color:transparent;touch-action:manipulation}' +
      'canvas{touch-action:none!important}' +
      'html,body{overscroll-behavior:none}';
    document.head.appendChild(s);

    // JS guards
    document.body.style.overscrollBehavior = 'none';
    window.addEventListener('contextmenu',   function(e){ e.preventDefault(); });
    document.addEventListener('gesturestart',function(e){ e.preventDefault(); }, { passive: false });
    document.addEventListener('gesturechange',function(e){ e.preventDefault(); }, { passive: false });
  }

}());
