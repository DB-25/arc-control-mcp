/**
 * Helpers injected into the page ahead of every DOM expression. Composed in
 * Node and shipped through Arc's `execute javascript`, so tool code stays
 * ordinary JavaScript instead of nested string building inside JXA.
 */
export const PAGE_LIB = `
var A = (function () {
  var api = {};

  var TEXT_PREFIX = 'text=';

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
  api.all = function (selector, root, opts) {
    root = root || document;
    opts = opts || {};
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

    var out = [];
    for (var e = 0; e < hits.length; e++) if (hits[e].exact) out.push(hits[e].el);
    for (var s = 0; s < hits.length; s++) if (!hits[s].exact) out.push(hits[s].el);
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
      disabled: !!el.disabled,
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

  api.click = function (el) {
    el.scrollIntoView({ block: 'center', inline: 'center' });
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
    if (el.disabled) throw new Error('<' + tag + '> is disabled, so it cannot be filled.');
    if (el.readOnly) throw new Error('<' + tag + '> is readonly, so it cannot be filled.');
    var proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value');
    el.focus();
    if (setter && setter.set) setter.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };

  api.key = function (el, key) {
    var printable = key.length === 1;
    var code = printable ? key.charCodeAt(0) : (KEY_CODES[key] || 0);
    var init = { key: key, keyCode: code, which: code, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    if (code) {
      el.dispatchEvent(new KeyboardEvent('keypress', {
        key: key, keyCode: code, which: code, charCode: printable ? code : 0,
        bubbles: true, cancelable: true
      }));
    }
    el.dispatchEvent(new KeyboardEvent('keyup', init));
    return true;
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
  return `${PAGE_LIB}
(function(){
  try {
    return A.envelope((function(){
${body}
    })());
  } catch (e) { return A.failure(e); }
})()`;
}
