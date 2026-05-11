/**
 * pvzge_web — Mobile Touch Support Patch
 * 
 * Drop this script into docs/ and add:
 *   <script src="mobile-touch-patch.js"></script>
 * just before </body> in docs/index.html
 *
 * What it fixes:
 *  1. Touch-to-mouse simulation → lets you tap seeds, buttons, plant on grid
 *  2. Touch-drag scrolling on the seed-packet bar (horizontal) and any
 *     vertically-scrolling panels (shop, almanac, etc.)
 *  3. Prevents iOS/Android "bounce", double-tap zoom, and context-menu on
 *     long-press — all of which break gameplay
 */

(function () {
  'use strict';

  /* ─── 1. Wait for the game canvas ─────────────────────────────────── */
  function init() {
    // Cocos Creator outputs a <canvas> — grab it once it exists.
    const canvas =
      document.getElementById('GameCanvas') ||
      document.querySelector('canvas');

    if (!canvas) {
      // Not ready yet — retry
      return requestAnimationFrame(init);
    }

    installTouchToMouse(canvas);
    installTouchScroll();
    lockViewport();
    console.log('[pvzge mobile patch] loaded ✓');
  }

  requestAnimationFrame(init);

  /* ─── 2. Touch → Mouse event bridge ───────────────────────────────── */
  /**
   * Cocos Creator web builds listen for mousedown/mousemove/mouseup on the
   * canvas.  We mirror every touch as the equivalent mouse event so that
   * existing game code (seed selection, planting, dragging) works untouched.
   */
  function installTouchToMouse(canvas) {
    let lastTap = 0;        // for double-tap guard
    let touching = false;

    // Which touch is our "primary" pointer (finger 0)
    let primaryId = null;

    function touchToMouse(type, touch) {
      const rect = canvas.getBoundingClientRect();
      // Scale from CSS pixels to canvas logical pixels
      const scaleX = canvas.width  / rect.width;
      const scaleY = canvas.height / rect.height;

      const clientX = touch.clientX;
      const clientY = touch.clientY;

      const evt = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 0,
        buttons: type === 'mouseup' ? 0 : 1,
        clientX,
        clientY,
        screenX: touch.screenX,
        screenY: touch.screenY,
      });
      canvas.dispatchEvent(evt);
    }

    canvas.addEventListener('touchstart', function (e) {
      e.preventDefault();
      if (primaryId === null) {
        primaryId = e.changedTouches[0].identifier;
        touching = true;
        touchToMouse('mousedown', e.changedTouches[0]);
      }
    }, { passive: false });

    canvas.addEventListener('touchmove', function (e) {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier === primaryId) {
          touchToMouse('mousemove', t);
          break;
        }
      }
    }, { passive: false });

    canvas.addEventListener('touchend', function (e) {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier === primaryId) {
          touchToMouse('mousemove', t); // ensure final position
          touchToMouse('mouseup', t);
          // Also fire a click so UI buttons that only listen for 'click' respond
          touchToMouse('click', t);
          primaryId = null;
          touching = false;
          break;
        }
      }
    }, { passive: false });

    canvas.addEventListener('touchcancel', function (e) {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier === primaryId) {
          touchToMouse('mouseup', t);
          primaryId = null;
          touching = false;
          break;
        }
      }
    }, { passive: false });
  }

  /* ─── 3. Touch-drag scrolling for overlay panels ──────────────────── */
  /**
   * The seed-packet chooser bar and other panels use overflow:auto or are
   * Cocos scroll-view nodes rendered as DOM overlays.  We intercept touch
   * drag and convert it to wheel events (which Cocos scroll views already
   * handle) so the user can scroll with a finger.
   *
   * We also add CSS touch-action rules as a first-class fix for any
   * native-scroll DOM panels the game wraps over the canvas.
   */
  function installTouchScroll() {
    // CSS: let any div/section that overflows scroll natively with touch
    const style = document.createElement('style');
    style.textContent = `
      /* Allow native touch-scroll on any overflow container the game creates */
      div, section, ul, nav {
        -webkit-overflow-scrolling: touch;
      }

      /* Prevent double-tap zoom globally — keeps gameplay snappy */
      * {
        touch-action: manipulation;
      }

      /* The canvas itself needs full touch control (handled in JS above) */
      canvas {
        touch-action: none !important;
        user-select: none;
        -webkit-user-select: none;
      }
    `;
    document.head.appendChild(style);

    /*
     * Wheel-event injection for Cocos scroll views:
     * When the user drags on a non-canvas element, synthesise a wheel event
     * so the Cocos scroll container scrolls.
     */
    let scrollStart = null;

    document.addEventListener('touchstart', function (e) {
      if (e.target.tagName === 'CANVAS') return; // handled above
      if (e.touches.length === 1) {
        scrollStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }
    }, { passive: true });

    document.addEventListener('touchmove', function (e) {
      if (e.target.tagName === 'CANVAS') return;
      if (!scrollStart || e.touches.length !== 1) return;

      const dx = scrollStart.x - e.touches[0].clientX;
      const dy = scrollStart.y - e.touches[0].clientY;

      // Fire wheel event on the element under the finger
      const target = e.target;
      const wheel = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaX: dx * 1.5,
        deltaY: dy * 1.5,
        deltaMode: 0,
        clientX: e.touches[0].clientX,
        clientY: e.touches[0].clientY,
      });
      target.dispatchEvent(wheel);

      scrollStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }, { passive: true });

    document.addEventListener('touchend', function () {
      scrollStart = null;
    }, { passive: true });
  }

  /* ─── 4. Viewport / bounce lock ───────────────────────────────────── */
  function lockViewport() {
    // Disable pull-to-refresh and overscroll bounce on iOS/Android
    document.body.style.overscrollBehavior = 'none';
    document.documentElement.style.overscrollBehavior = 'none';

    // Disable context menu (long-press on Android)
    window.addEventListener('contextmenu', (e) => e.preventDefault());

    // Disable pinch-zoom on the game (viewport meta may already do this,
    // but belt-and-suspenders)
    document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
    document.addEventListener('gesturechange', (e) => e.preventDefault(), { passive: false });
  }

})();
