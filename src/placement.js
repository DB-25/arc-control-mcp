// Where the agent window goes. Pure geometry, so it is testable without a
// display. NSScreen reports frames with the origin at the bottom-left of the
// MAIN display and y growing upward, while Accessibility positions windows from
// the top-left of the main display with y growing downward. Every function
// here takes NSScreen-style frames and returns Accessibility-style rectangles.

const DEFAULT_WINDOW_WIDTH = 1100;
const DEFAULT_WINDOW_HEIGHT = 800;

/**
 * @typedef {{x: number, y: number, width: number, height: number}} Rect
 * @typedef {{frame: Rect, visibleFrame: Rect}} Screen  screens[0] is the main display
 */

/** NSScreen frame (bottom-left origin) to Accessibility rectangle (top-left origin). */
export function toAxRect(frame, mainHeight) {
  return {
    x: frame.x,
    y: mainHeight - (frame.y + frame.height),
    width: frame.width,
    height: frame.height
  };
}

const area = (rect) => rect.width * rect.height;

/** Both frames of every screen, in Accessibility coordinates. */
export function axScreens(screens) {
  if (!Array.isArray(screens) || screens.length === 0) return [];
  const mainHeight = screens[0].frame.height;
  return screens.map((screen, index) => ({
    index,
    isMain: index === 0,
    frame: toAxRect(screen.frame, mainHeight),
    visibleFrame: toAxRect(screen.visibleFrame || screen.frame, mainHeight)
  }));
}

/** The largest display that is not the main one, by usable area, or null. */
export function largestSecondary(screens) {
  const others = axScreens(screens).filter((screen) => !screen.isMain);
  if (others.length === 0) return null;
  return others.reduce((best, screen) => (area(screen.visibleFrame) > area(best.visibleFrame) ? screen : best));
}

/** Which display holds the center of a window, so status can say where it is. */
export function displayOfWindow(screens, window) {
  const cx = window.x + window.width / 2;
  const cy = window.y + window.height / 2;
  const hit = axScreens(screens).find(
    ({ frame }) => cx >= frame.x && cx < frame.x + frame.width && cy >= frame.y && cy < frame.y + frame.height
  );
  return hit ? { index: hit.index, isMain: hit.isMain, width: hit.frame.width, height: hit.frame.height } : null;
}

function centeredOn(visible, size) {
  const width = Math.min(size.width, visible.width);
  const height = Math.min(size.height, visible.height);
  return {
    x: Math.round(visible.x + (visible.width - width) / 2),
    y: Math.round(visible.y + (visible.height - height) / 2),
    width,
    height
  };
}

/**
 * Decide what to do with the agent window.
 * Returns { action: 'move' | 'minimize' | 'none', placement, rect?, display?, note? }
 * where `placement` is what was actually applied, which can differ from what
 * was asked for when the machine cannot do it. `auto` is the largest display
 * that is not the main one, and otherwise leaves the window where Arc put it:
 * minimizing is not a default until it has been verified live.
 */
export function planPlacement({ screens, placement = 'auto', windowSize }) {
  if (placement === 'none') return { action: 'none', placement: 'none' };
  if (placement === 'minimized') return { action: 'minimize', placement: 'minimized' };

  const secondary = largestSecondary(screens);
  if (secondary) {
    const size = {
      width: windowSize?.width || DEFAULT_WINDOW_WIDTH,
      height: windowSize?.height || DEFAULT_WINDOW_HEIGHT
    };
    return {
      action: 'move',
      placement: 'second-display',
      rect: centeredOn(secondary.visibleFrame, size),
      display: secondary.index
    };
  }
  return {
    action: 'none',
    placement: 'none',
    ...(placement === 'second-display'
      ? { note: 'Only one display is connected, so the agent window was left where Arc put it.' }
      : {})
  };
}
