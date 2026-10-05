import { SNAPSHOT_LIB } from './page-snapshot.js';

// The snapshot helpers are a few hundred lines, and every call ships the
// library through osascript, so they ride along only when the script can use
// them. A false positive costs bytes, never correctness.
const SEMANTIC_HINT = /\b(?:ref|role|label|placeholder)\s*=|A\.snapshot/;

/**
 * Helpers injected into the page ahead of every DOM expression. Composed in
 * Node and shipped through Arc's `execute javascript`, so tool code stays
 * ordinary JavaScript instead of nested string building inside JXA.
 */
export const PAGE_LIB = `
var A = (function () {
  var api = {};

  var TEXT_PREFIX = 'text=';
  // ref=, role=, label= and placeholder= are resolved by the semantic helpers
  // in page-snapshot.js, which are injected only when a script mentions them.
  var SEMANTIC = /^(?:ref|role|label|placeholder)=/;

  // Named keys get a legacy keyCode. Printable characters are handled
  // separately, since keypress needs a charCode to look real to old handlers.
  var KEY_CODES = {
    Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Space: 32,
    ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39,
    Home: 36, End: 35, PageUp: 33, PageDown: 34
  };

  var TEXT_CANDIDATES = 'a,button,[role=button],[role=link],[role=menuitem],[role=option],[role=tab],input,label,summary,li,td,th,h1,h2,h3,h4,h5,h6,span,div,p,legend,option';

  function textOf(el) {
    var t = el.innerText;
    if (t === undefined || t === null || t === '') t = el.value;
    if (t === undefined || t === null) t = '';
    return String(t).trim();
  }

  // "text=Sign in" matches on visible text, anything else is a CSS selector.
  // Exact matches come back before substring matches, so the obvious target
  // wins on a page where the same word appears inside longer labels.
  // api.last reports what the latest lookup had to do beyond finding the
  // element, so a handler can say a ref was re-resolved.
  api.last = { reResolved: false };
  api.all = function (selector, root, opts) {
    root = root || document;
    opts = opts || {};
    api.last = { reResolved: false };
    if (SEMANTIC.test(selector)) {
      if (!api.semantic) {
        throw new Error('The selector "' + selector + '" needs the semantic helpers, which are injected only when the script text mentions ref=, role=, label= or placeholder=. Write the selector as a literal in the script.');
      }
      return api.semantic(selector, root, opts);
    }
    if (selector.indexOf(TEXT_PREFIX) !== 0) {
      return Array.prototype.slice.call(root.querySelectorAll(selector));
    }

    var needle = selector.slice(TEXT_PREFIX.length).trim().toLowerCase();
    var nodes = root.querySelectorAll(TEXT_CANDIDATES);
    var hits = [];
    for (var i = 0; i < nodes.length; i++) {
      var t = textOf(nodes[i]).toLowerCase();
      if (!t || t.length > 300) continue;
      var exact = t === needle;
      if (!exact && (opts.exact || t.indexOf(needle) === -1)) continue;
      // Keep the innermost match only: drop ancestors already collected, and
      // skip this node when a descendant of it is already in the list.
      var nested = false;
      for (var j = 0; j < hits.length; j++) {
        if (hits[j].el.contains(nodes[i])) { hits.splice(j, 1); j--; }
      }
      for (var k = 0; k < hits.length; k++) {
        if (nodes[i].contains(hits[k].el)) { nested = true; break; }
      }
      if (!nested) hits.push({ el: nodes[i], exact: exact });
    }

    // Visible before hidden within each group: a hidden twin earlier in the
    // DOM (a collapsed menu, an off-screen template) must not win the click.
    var out = [];
    var groups = [[], [], [], []];
    for (var e = 0; e < hits.length; e++) {
      groups[(hits[e].exact ? 0 : 2) + (api.visible(hits[e].el) ? 0 : 1)].push(hits[e].el);
    }
    for (var g = 0; g < groups.length; g++) out = out.concat(groups[g]);
    return out;
  };

  api.one = function (selector, nth, opts) {
    var list = api.all(selector, null, opts);
    return list[nth || 0] || null;
  };

  api.visible = function (el) {
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    // A 1x1 box is the standard screen-reader clipping trick, not something a
    // user could click, so report it as hidden.
    if (r.width < 2 || r.height < 2) return false;
    var s = window.getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') return false;
    if (s.clipPath && /inset\\(\\s*(?:100%|50%)/.test(s.clipPath)) return false;
    return true;
  };

  api.describe = function (el, verbose) {
    if (!el) return null;
    var cap = verbose ? 200 : 120;
    var attrs = {};
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i];
      if (a.name === 'style') continue;
      attrs[a.name] = a.value.length > cap ? a.value.slice(0, cap) + '\\u2026' : a.value;
    }
    var out = {
      tag: el.tagName.toLowerCase(),
      text: textOf(el).slice(0, verbose ? 400 : 200) || null,
      value: 'value' in el ? el.value : null,
      href: el.href || null,
      visible: api.visible(el),
      // The nearest control's state, so a label inside a disabled button reads as disabled.
      disabled: api.disabled(el),
      checked: 'checked' in el ? !!el.checked : null,
      attrs: attrs
    };
    // rect is the bulkiest field and is rarely actionable, so it is opt-in.
    if (verbose) {
      var r = el.getBoundingClientRect();
      out.rect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    }
    return out;
  };

  api.center = function (el) {
    var r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };

  var CONTROLS = 'button,a[href],input,select,textarea,summary,label,[role=button],[role=link],[role=menuitem],[role=option],[role=tab],[role=checkbox],[role=switch]';

  // "text=Save" usually lands on a label span inside the button, so the
  // element that decides whether a click does anything is the nearest control.
  api.control = function (el) {
    return (el.closest && el.closest(CONTROLS)) || el;
  };

  // A disabled control drops the click silently, which would otherwise read as
  // a successful click that the page ignored.
  api.disabled = function (el) {
    var c = api.control(el);
    if (c.matches && c.matches(':disabled')) return true;
    return !!(c.closest && c.closest('[aria-disabled=true]'));
  };

  // What a real pointer would hit at the element's center, when that is not
  // the element itself: an overlay, a backdrop, or what lies beneath a
  // pointer-events:none target. Null when the hit lands on it.
  api.coveredBy = function (el) {
    var p = api.center(el);
    if (p.x < 0 || p.y < 0 || p.x > window.innerWidth || p.y > window.innerHeight) return null;
    var hit = document.elementFromPoint(p.x, p.y);
    // Landing anywhere inside the control the match belongs to is a fair hit.
    if (!hit || el.contains(hit) || api.control(el).contains(hit)) return null;
    return '<' + hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') + '>';
  };

  api.click = function (el) {
    // Instant, or the center is measured mid-animation on scroll-behavior: smooth pages.
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    var p = api.center(el);
    var opts = { bubbles: true, cancelable: true, view: window, clientX: p.x, clientY: p.y, button: 0 };
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (type) {
      var Ctor = type.indexOf('pointer') === 0 && window.PointerEvent ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ctor(type, opts));
    });
    return true;
  };

  // Uses the native setter so React and other frameworks see the change.
  api.setValue = function (el, value) {
    if (el.isContentEditable) {
      el.focus();
      el.textContent = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    var tag = el.tagName.toLowerCase();
    if (tag === 'select') {
      throw new Error('A <select> cannot be filled. Use select_option instead.');
    }
    if (tag !== 'input' && tag !== 'textarea') {
      throw new Error('<' + tag + '> is not an input, textarea or contenteditable element, so it cannot be filled.');
    }
    // :disabled also covers a field inside <fieldset disabled>, which el.disabled misses.
    if (el.matches(':disabled')) throw new Error('<' + tag + '> is disabled, so it cannot be filled.');
    if (el.readOnly) throw new Error('<' + tag + '> is readonly, so it cannot be filled.');
    var type = tag === 'input' ? (el.type || 'text') : null;
    if (/^(checkbox|radio|button|submit|reset|image|file)$/.test(type)) {
      throw new Error('<input type=' + type + '> has no text to fill.' + (type === 'file' ? ' A file input cannot be set from a script.' : ' Use click instead.'));
    }
    var proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value');
    el.focus();
    if (setter && setter.set) setter.set.call(el, value); else el.value = value;
    // Number, date and similar inputs sanitise a value they cannot parse to "".
    if (el.value !== value) {
      throw new Error('<input type=' + type + '> did not accept ' + JSON.stringify(value) + ': its value is now ' + JSON.stringify(el.value) + '.');
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };

  // Returns whether the page cancelled the keydown. A synthetic key has no
  // default action: no character is typed, focus does not move, and Enter does
  // not submit a form, so only the page's own handlers react.
  api.key = function (el, key) {
    var printable = key.length === 1;
    if (!printable && !KEY_CODES[key]) {
      throw new Error('Unknown key "' + key + '". Use a single character or one of: ' + Object.keys(KEY_CODES).join(', ') + '.');
    }
    var code = printable ? key.charCodeAt(0) : KEY_CODES[key];
    var eventKey = key === 'Space' ? ' ' : key;
    var init = { key: eventKey, keyCode: code, which: code, bubbles: true, cancelable: true };
    var down = new KeyboardEvent('keydown', init);
    el.dispatchEvent(down);
    el.dispatchEvent(new KeyboardEvent('keypress', {
      key: eventKey, keyCode: code, which: code, charCode: printable || key === 'Space' ? code : 0,
      bubbles: true, cancelable: true
    }));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
    return down.defaultPrevented;
  };

  // A mutating action starts a MutationObserver before it acts, and the Node
  // side polls settleStatus afterwards. The wait cannot happen inside the
  // action's own call: Arc's execute javascript returns synchronously, and
  // blocking would also freeze the page's timers that are meant to react.
  function now() { return window.performance.now(); }

  api.watch = function () {
    var prev = window.__arcWatch;
    if (prev && prev.obs) prev.obs.disconnect();
    var st = { id: Math.random().toString(36).slice(2), start: now(), last: null, count: 0, obs: null };
    st.obs = new MutationObserver(function (records) {
      st.last = now();
      st.count += records.length;
    });
    st.obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    Object.defineProperty(window, '__arcWatch', { value: st, writable: true, configurable: true, enumerable: false });
    return st.id;
  };

  api.settleStatus = function (id, quietMs) {
    var st = window.__arcWatch;
    // A navigation replaces the window, and the observer goes with it.
    if (!st || st.id !== id) return { lost: true };
    // Records queued but not yet delivered still count as activity.
    var pending = st.obs.takeRecords();
    if (pending.length) { st.last = now(); st.count += pending.length; }
    var t = now();
    var quietFor = Math.round(t - (st.last === null ? st.start : st.last));
    var done = quietFor >= quietMs;
    if (done) st.obs.disconnect();
    return {
      done: done,
      quietFor: quietFor,
      settledMs: st.last === null ? 0 : Math.round(st.last - st.start),
      mutations: st.count,
      hidden: document.hidden
    };
  };

  api.miss = function (selector) {
    return { error: 'no_match', selector: selector };
  };

  // Every injected script resolves to one of these two envelopes, so the Node
  // side can tell "returned nothing" apart from "threw".
  api.envelope = function (v) {
    var out = { __arc: 1, ok: true };
    var json;
    try {
      json = JSON.stringify(v);
    } catch (e) {
      return api.failure(new Error('Result is not JSON-serialisable: ' + (e && e.message ? e.message : e)));
    }
    if (json !== undefined) out.v = v;
    if (json === '{}' && v && typeof v === 'object') {
      var ctor = v.constructor && v.constructor.name;
      if (ctor && ctor !== 'Object') {
        out.note = ctor + ' has no JSON representation. Return specific properties, or A.describe(el) for an element.';
      }
    }
    return out;
  };

  api.failure = function (e) {
    return {
      __arc: 1,
      ok: false,
      name: e && e.name ? String(e.name) : 'Error',
      error: e && e.message ? String(e.message) : String(e)
    };
  };

  return api;
})();
`;

/**
 * Wrap page code so it always resolves to an envelope: `{ __arc: 1, ok: true,
 * v }` when it returned, `{ __arc: 1, ok: false, name, error }` when it threw.
 * Arc hands back an empty string for a thrown script, which is otherwise
 * indistinguishable from a page value of null.
 */
export function pageScript(body) {
  return `${PAGE_LIB}${SEMANTIC_HINT.test(body) ? SNAPSHOT_LIB : ''}
(function(){
  try {
    return A.envelope((function(){
${body}
    })());
  } catch (e) { return A.failure(e); }
})()`;
}
