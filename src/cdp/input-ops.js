/**
 * Trusted input: real Input.dispatch* events, which pages see as isTrusted
 * true and which act like a user (Enter submits, Tab moves focus, a drag moves
 * a slider). Each op returns the tool's result object; thrown errors are real
 * faults, and a refusal is `{ ok: false }`.
 */
import { ArcError } from '../jxa.js';
import { keyPressEvents, charEvents, MOUSE_BUTTONS } from './keys.js';
import { locate, fail, withDialog } from './tab.js';

const DRAG_STEPS = 12;
// A drag that Chrome intercepts reports it just after the first moves; this is
// how long to wait for that before assuming it is a plain mouse drag.
const DRAG_INTERCEPT_WAIT_MS = 150;

const mouse = (t, type, x, y, extra = {}) =>
  t.input('Input.dispatchMouseEvent', { type, x, y, button: 'none', buttons: 0, ...extra });

async function clickAt(t, { x, y, button, clickCount }) {
  await mouse(t, 'mouseMoved', x, y);
  // click_count 2 is two full press/release pairs, so the page gets a dblclick.
  for (let i = 1; i <= clickCount; i++) {
    await mouse(t, 'mousePressed', x, y, { button, buttons: MOUSE_BUTTONS[button], clickCount: i });
    await mouse(t, 'mouseReleased', x, y, { button, buttons: 0, clickCount: i });
  }
}

export async function trustedClick(t, args) {
  await t.prepareInput();
  const { found, failure } = await locate(t, args, { refuseDisabled: true });
  if (failure) return failure;
  const button = args.button ?? 'left';
  const clickCount = args.click_count ?? 1;
  const result = {
    ok: true,
    clicked: found.target,
    matches: found.matches,
    at: { x: Math.round(found.x), y: Math.round(found.y) },
    button,
    clickCount,
    coveredBy: found.coveredBy
  };
  if (found.coveredBy) {
    // A real pointer goes where the user's would: onto whatever is on top.
    result.warning = `${found.coveredBy} sits on top of this element at its center, so the real click landed on it instead. Check that the intended thing happened.`;
  }
  return withDialog(result, () => clickAt(t, { x: found.x, y: found.y, button, clickCount }));
}

export async function trustedHover(t, args) {
  await t.prepareInput();
  const { found, failure } = await locate(t, args);
  if (failure) return failure;
  const result = { ok: true, hovered: found.target, matches: found.matches, at: { x: Math.round(found.x), y: Math.round(found.y) }, coveredBy: found.coveredBy };
  await withDialog(result, () => mouse(t, 'mouseMoved', found.x, found.y));
  if (result.dialog) return result;
  // Whether the browser applied :hover is the honest answer to "did it work".
  result.hoverApplied = await t
    .page(`var el = A.all(${JSON.stringify(args.selector)}, null, ${JSON.stringify({ exact: args.exact === true })})[${args.nth ?? 0}]; return !!el && el.matches(':hover');`)
    .catch(() => undefined);
  return result;
}

/** Focus (and optionally select the contents of) the element that is about to receive text. */
async function focusEditable(t, { selector, nth = 0, exact, clear }) {
  const select = `
    if (${clear === true}) {
      if (typeof el.select === 'function' && !el.isContentEditable) el.select();
      else document.getSelection().selectAllChildren(el);
    }`;
  const body = selector
    ? `var els = A.all(${JSON.stringify(selector)}, null, ${JSON.stringify({ exact: exact === true })});
       var el = els[${nth}];
       if (!el) return { error: 'no_match', matches: els.length };
       var tag = el.tagName.toLowerCase();
       if (!el.isContentEditable) {
         if (tag !== 'input' && tag !== 'textarea') return { error: 'not_editable', tag: tag };
         if (el.matches(':disabled')) return { error: 'disabled', tag: tag };
         if (el.readOnly) return { error: 'readonly', tag: tag };
         if (/^(checkbox|radio|button|submit|reset|image|file|range|color)$/.test(el.type)) return { error: 'not_text', tag: tag, type: el.type };
       }
       el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
       el.focus();
       ${select}
       return { matches: els.length, focused: document.activeElement === el, target: A.describe(el, false) };`
    : `var el = document.activeElement;
       if (!el || el === document.body || el === document.documentElement) return { error: 'nothing_focused' };
       ${select}
       return { matches: 1, focused: true, target: A.describe(el, false) };`;
  return t.page(body);
}

const FOCUS_FAILURES = {
  not_editable: (r, s) => `${s} is a <${r.tag}>, not an input, textarea or contenteditable element. Use trusted_click to focus a custom widget first, then call this with no selector.`,
  disabled: (r, s) => `${s} is a disabled <${r.tag}>, so typing would do nothing.`,
  readonly: (r, s) => `${s} is a readonly <${r.tag}>, so typing would do nothing.`,
  not_text: (r, s) => `${s} is an <input type=${r.type}>, which takes no typed text. Use trusted_click.`,
  nothing_focused: () => 'Nothing is focused, so there is nowhere for the text to go. Pass a selector, or click into a field first.'
};

export async function trustedType(t, args) {
  await t.prepareInput();
  const focus = await focusEditable(t, args);
  if (focus.error === 'no_match') return fail(`No element matches ${args.selector}`, { matches: focus.matches });
  if (focus.error) return fail(FOCUS_FAILURES[focus.error](focus, args.selector), {});
  const result = { ok: true, typed: args.text.length, mode: args.per_key ? 'per_key' : 'insert_text', matches: focus.matches, target: focus.target };
  if (!focus.focused) {
    result.warning = 'The element did not take focus, so the text went to whatever has it. Check the value below.';
  }
  await withDialog(result, async () => {
    if (args.per_key) {
      for (const char of args.text) {
        for (const event of charEvents(char)) await t.input('Input.dispatchKeyEvent', event);
      }
    } else if (args.text !== '') {
      await t.input('Input.insertText', { text: args.text });
    }
    // clear with nothing to type still has to delete the selection.
    if (args.clear && args.text === '') {
      for (const event of keyPressEvents('Backspace')) await t.input('Input.dispatchKeyEvent', event);
    }
  });
  if (!result.dialog) {
    // Read back what landed. A password's value is not echoed, only its length.
    result.after = await t
      .page(`var el = document.activeElement; if (!el) return null;
             var v = 'value' in el ? el.value : el.textContent;
             var secret = el.type === 'password';
             return { tag: el.tagName.toLowerCase(), value: secret ? null : v, valueLength: String(v).length };`)
      .catch(() => undefined);
  }
  return result;
}

export async function trustedPressKey(t, args) {
  // Parsed first, so a bad key name fails before the page is touched.
  const events = keyPressEvents(args.key);
  await t.prepareInput();
  const result = { ok: true, key: args.key };
  if (args.selector) {
    const focus = await t.page(
      `var els = A.all(${JSON.stringify(args.selector)}, null, ${JSON.stringify({ exact: args.exact === true })});
       var el = els[${args.nth ?? 0}];
       if (!el) return { error: 'no_match', matches: els.length };
       el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
       el.focus();
       return { matches: els.length, focused: document.activeElement === el };`
    );
    if (focus.error) return fail(`No element matches ${args.selector}`, { matches: focus.matches });
    result.matches = focus.matches;
    if (!focus.focused) result.warning = `${args.selector} could not take focus, so the key went to the element that has it.`;
  }
  await withDialog(result, async () => {
    for (const event of events) await t.input('Input.dispatchKeyEvent', event);
  });
  if (result.dialog) return result;
  // After Enter or Tab the page may have navigated or moved focus: say where it is now.
  result.activeElement = await t
    .page(`var a = document.activeElement; return a ? { tag: a.tagName.toLowerCase(), id: a.id || undefined, name: a.getAttribute('name') || undefined, type: a.type || undefined } : null;`)
    .catch(() => undefined);
  if (result.activeElement === undefined) result.note = 'The page was busy or navigating right after the key, so the focused element is unknown.';
  return result;
}

async function endpoint(t, args, side) {
  const selector = args[`${side}_selector`];
  const x = args[`${side}_x`];
  const y = args[`${side}_y`];
  if (selector && (x !== undefined || y !== undefined)) throw new ArcError(`Give ${side}_selector or ${side}_x and ${side}_y, not both.`);
  if (selector) {
    const { found, failure } = await locate(t, { selector, nth: args[`${side}_nth`] });
    return failure ? { failure } : { point: { x: found.x, y: found.y }, target: found.target };
  }
  if (x === undefined || y === undefined) throw new ArcError(`Give ${side}_selector, or both ${side}_x and ${side}_y.`);
  return { point: { x, y } };
}

export async function drag(t, args) {
  const from = await endpoint(t, args, 'from');
  if (from.failure) return from.failure;
  const to = await endpoint(t, args, 'to');
  if (to.failure) return to.failure;
  await t.prepareInput();
  const steps = args.steps ?? DRAG_STEPS;
  const result = { ok: true, from: from.target ?? from.point, to: to.target ?? to.point, steps, nativeDrag: false };

  // Interception turns a native HTML5 drag, which would otherwise start an OS
  // drag session nothing can finish, into data we replay as drag events.
  let intercepted = null;
  const off = t.tab.session.on('Input.dragIntercepted', (p) => { intercepted = p.data; });
  await t.send('Input.setInterceptDrags', { enabled: true });
  try {
    await withDialog(result, async () => {
      const a = from.point;
      const b = to.point;
      await mouse(t, 'mouseMoved', a.x, a.y);
      await mouse(t, 'mousePressed', a.x, a.y, { button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i <= steps; i++) {
        await mouse(t, 'mouseMoved', a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps, { button: 'left', buttons: 1 });
      }
      if (!intercepted) await new Promise((resolve) => setTimeout(resolve, DRAG_INTERCEPT_WAIT_MS));
      if (intercepted) {
        result.nativeDrag = true;
        for (const type of ['dragEnter', 'dragOver', 'drop']) {
          await t.input('Input.dispatchDragEvent', { type, x: b.x, y: b.y, data: intercepted });
        }
      }
      await mouse(t, 'mouseReleased', b.x, b.y, { button: 'left', buttons: 0, clickCount: 1 });
    });
  } finally {
    off();
    await t.send('Input.setInterceptDrags', { enabled: false }).catch(() => {});
  }
  return result;
}
