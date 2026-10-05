/**
 * The page-side half of snapshots and semantic selectors: roles, accessible
 * names, a scan of the document, and the ref table. page-snapshot.js builds the
 * text tree on top of it, and A.all uses it for ref=, role=, label= and
 * placeholder= selectors.
 *
 * String.raw keeps the regular expressions below readable: this is injected
 * source, so a doubled backslash here would be a doubled backslash in the page.
 * Avoid backticks and dollar-brace inside it for the same reason.
 *
 * Everything touching `window` or `document` sits inside a function, so the
 * script still parses and loads in the bare vm context the unit tests use.
 */
export const SEMANTIC_LIB = String.raw`
(function (api) {
  var MAX_NAME = 100;
  var MAX_NODES = 30000;
  var MAX_REFS = 5000;
  var SEP = '\u0001';

  var SKIP = { script: 1, style: 1, noscript: 1, template: 1, head: 1, meta: 1, link: 1, title: 1, base: 1 };
  var INLINE = { a: 1, span: 1, b: 1, i: 1, em: 1, strong: 1, small: 1, code: 1, abbr: 1, label: 1, sup: 1, sub: 1, mark: 1, u: 1, s: 1, time: 1, cite: 1, kbd: 1, q: 1, var: 1, samp: 1, font: 1, bdi: 1, bdo: 1 };
  // Roles whose accessible name is the text inside them.
  var FROM_CONTENT = { button: 1, link: 1, heading: 1, tab: 1, menuitem: 1, menuitemcheckbox: 1, menuitemradio: 1, option: 1, checkbox: 1, radio: 1, switch: 1, treeitem: 1, columnheader: 1, rowheader: 1, tooltip: 1 };
  var INTERACTIVE = { button: 1, link: 1, textbox: 1, searchbox: 1, combobox: 1, listbox: 1, checkbox: 1, radio: 1, switch: 1, slider: 1, spinbutton: 1, tab: 1, menuitem: 1, menuitemcheckbox: 1, menuitemradio: 1, option: 1, treeitem: 1 };
  // Wrappers that say nothing a reader needs: their children are shown in their place.
  var TRANSPARENT = { generic: 1, paragraph: 1, rowgroup: 1, label: 1 };
  // A form, region, group or figure with no name is only a box.
  var NEEDS_NAME = { form: 1, region: 1, group: 1, figure: 1 };
  var INPUT_ROLE = { button: 'button', submit: 'button', reset: 'button', image: 'button', file: 'button', checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox' };
  var TAG_ROLE = {
    a: 'link', area: 'link', button: 'button', summary: 'button', textarea: 'textbox', option: 'option',
    optgroup: 'group', fieldset: 'group', details: 'group', img: 'img', nav: 'navigation', main: 'main',
    aside: 'complementary', ul: 'list', ol: 'list', menu: 'list', li: 'listitem', table: 'table',
    thead: 'rowgroup', tbody: 'rowgroup', tfoot: 'rowgroup', tr: 'row', td: 'cell', th: 'columnheader',
    dialog: 'dialog', progress: 'progressbar', meter: 'meter', hr: 'separator', article: 'article',
    output: 'status', form: 'form', section: 'region', figure: 'figure', blockquote: 'blockquote',
    caption: 'caption', p: 'paragraph', iframe: 'iframe', frame: 'iframe', label: 'label',
    h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading'
  };
  var CONTROL_TAGS = { input: 1, select: 1, textarea: 1, button: 1, meter: 1, progress: 1, output: 1 };

  function norm(s) { return String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').trim(); }
  function cap(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function tagOf(el) { return el.tagName.toLowerCase(); }

  // Page-resident state, so refs survive from one call to the next. It is
  // non-enumerable: a page that loops over window should not trip on it.
  function state() {
    if (!window.__arcSnap) {
      Object.defineProperty(window, '__arcSnap', {
        value: { next: 1, refs: new Map(), ids: new WeakMap(), byKey: new Map(), last: null },
        writable: true, configurable: true, enumerable: false
      });
    }
    return window.__arcSnap;
  }

  function alive(el) { return !!(el && el.isConnected && el.ownerDocument.defaultView); }

  // Children as the page renders them: a shadow root stands in for its host's
  // light children, which reach the tree again through its slots.
  function kidsOf(node) {
    if (node.nodeType === 1) {
      var tag = tagOf(node);
      if (tag === 'slot' && node.assignedNodes) {
        var assigned = node.assignedNodes({ flatten: true });
        if (assigned.length) return assigned;
      }
      if (node.shadowRoot) return node.shadowRoot.childNodes;
      if (tag === 'iframe' || tag === 'frame') {
        // Cross-origin frames throw or give null: their contents are not ours to read.
        try {
          var d = node.contentDocument;
          return d && d.documentElement ? [d.documentElement] : [];
        } catch (e) { return []; }
      }
    }
    return node.childNodes;
  }

  function isHidden(el) {
    if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('inert')) return true;
    var view = el.ownerDocument.defaultView;
    if (!view) return true;
    if (view.getComputedStyle(el).display === 'none') return true;
    var p = el.parentElement;
    return !!(p && p.tagName === 'DETAILS' && !p.open && el.tagName !== 'SUMMARY');
  }

  // Not drawn, but its children may be: visibility can be switched back on below.
  function isInvisible(el) {
    var v = el.ownerDocument.defaultView.getComputedStyle(el).visibility;
    return v === 'hidden' || v === 'collapse';
  }

  function contentText(el, includeHidden) {
    var out = [];
    collect(el, out, includeHidden);
    return out.join('');
  }

  function collect(node, out, inc) {
    var kids = kidsOf(node);
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k.nodeType === 3) { out.push(k.data); continue; }
      if (k.nodeType !== 1) continue;
      var tag = tagOf(k);
      if (SKIP[tag] || tag === 'iframe' || tag === 'frame' || tag === 'select' || tag === 'textarea') continue;
      if (!inc && isHidden(k)) continue;
      if (tag === 'input') {
        if (/^(button|submit|reset)$/.test(k.type || '')) out.push(' ' + (k.value || '') + ' ');
        continue;
      }
      var label = k.getAttribute('aria-label');
      if (label) { out.push(' ' + label + ' '); continue; }
      if (tag === 'img' || tag === 'area') {
        var alt = k.getAttribute('alt');
        if (alt) out.push(' ' + alt + ' ');
        continue;
      }
      var block = !INLINE[tag];
      if (block) out.push(' ');
      collect(k, out, inc);
      if (block) out.push(' ');
    }
  }

  function byId(el, id) {
    var root = el.getRootNode();
    return (root.getElementById ? root.getElementById(id) : null) || el.ownerDocument.getElementById(id);
  }

  function attrName(el) {
    var by = el.getAttribute('aria-labelledby');
    if (by) {
      var parts = [];
      var ids = by.split(/\s+/);
      for (var i = 0; i < ids.length; i++) {
        var ref = ids[i] ? byId(el, ids[i]) : null;
        if (ref) parts.push(contentText(ref, true));
      }
      var joined = norm(parts.join(' '));
      if (joined) return joined;
    }
    return norm(el.getAttribute('aria-label'));
  }

  function labelsText(el) {
    var out = [];
    var l = attrName(el);
    if (l) out.push(l);
    if (el.labels) {
      for (var i = 0; i < el.labels.length; i++) {
        var t = norm(contentText(el.labels[i], false));
        if (t) out.push(t);
      }
    }
    return out;
  }

  function nativeName(el, tag) {
    if (tag === 'img' || tag === 'area') return norm(el.getAttribute('alt'));
    if (tag === 'input') {
      var type = (el.type || 'text').toLowerCase();
      if (type === 'image') return norm(el.getAttribute('alt')) || 'Submit';
      if (type === 'button' || type === 'submit' || type === 'reset') {
        return norm(el.value) || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '');
      }
    }
    if (CONTROL_TAGS[tag]) {
      var labels = labelsText(el);
      if (labels.length) return labels.join(' ');
    }
    if (tag === 'optgroup') return norm(el.getAttribute('label'));
    if (tag === 'fieldset') {
      var legend = el.querySelector('legend');
      return legend ? norm(contentText(legend, false)) : '';
    }
    if (tag === 'table') {
      var caption = el.querySelector('caption');
      return caption ? norm(contentText(caption, false)) : '';
    }
    if (tag === 'figure') {
      var fc = el.querySelector('figcaption');
      return fc ? norm(contentText(fc, false)) : '';
    }
    return '';
  }

  function inputRole(el) {
    var type = (el.type || 'text').toLowerCase();
    if (type === 'hidden') return 'none';
    if (INPUT_ROLE[type]) return INPUT_ROLE[type];
    return el.getAttribute('list') ? 'combobox' : 'textbox';
  }

  function implicitRole(el, tag) {
    if (tag === 'input') return inputRole(el);
    if (tag === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (tag === 'a' || tag === 'area') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'img') return el.getAttribute('alt') === '' && !el.getAttribute('title') ? 'generic' : 'img';
    if (tag === 'th') return el.getAttribute('scope') === 'row' ? 'rowheader' : 'columnheader';
    if (tag === 'header' || tag === 'footer') {
      var scoped = el.closest && el.closest('article,aside,main,nav,section');
      return scoped ? 'generic' : (tag === 'header' ? 'banner' : 'contentinfo');
    }
    var ce = el.getAttribute('contenteditable');
    if (ce !== null && ce !== 'false') return 'textbox';
    return TAG_ROLE[tag] || 'generic';
  }

  function roleOf(el, tag) {
    var explicit = el.getAttribute('role');
    if (explicit) {
      var r = explicit.trim().split(/\s+/)[0].toLowerCase();
      if (r && r !== 'none' && r !== 'presentation') return r;
    }
    return implicitRole(el, tag);
  }

  function isClickable(el) {
    return el.hasAttribute('onclick') || (el.hasAttribute('tabindex') && el.tabIndex >= 0);
  }

  function computeInfo(el) {
    var tag = tagOf(el);
    var role = roleOf(el, tag);
    var name = '';
    var clickable = false;
    if (role === 'generic') {
      name = attrName(el);
      clickable = isClickable(el);
      if (clickable && !name) name = norm(contentText(el, false));
    } else if (role !== 'none') {
      name = attrName(el) || nativeName(el, tag);
      if (!name && (FROM_CONTENT[role] || tag === 'summary')) name = norm(contentText(el, false));
      if (!name) name = norm(el.getAttribute('title')) || norm(el.getAttribute('placeholder'));
    }
    name = cap(name, MAX_NAME);
    if (NEEDS_NAME[role] && !name) role = 'generic';
    return { tag: tag, role: role, name: name, clickable: clickable, invisible: isInvisible(el) };
  }

  function newCtx() {
    return { cache: new Map(), index: new Map(), nth: new Map(), all: [], nodes: 0, hit: false };
  }

  function infoOf(ctx, el) {
    var info = ctx.cache.get(el);
    if (!info) { info = computeInfo(el); ctx.cache.set(el, info); }
    return info;
  }

  function keyOf(role, name) { return role + SEP + name; }

  // Visits every element the way the snapshot does: hidden subtrees are
  // skipped, shadow roots and same-origin frames are entered.
  function each(node, fn, ctx, includeHidden) {
    var kids = kidsOf(node);
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k.nodeType !== 1 || SKIP[tagOf(k)]) continue;
      if (!includeHidden && isHidden(k)) continue;
      if (++ctx.nodes > MAX_NODES) { ctx.hit = true; return false; }
      fn(k);
      if (each(k, fn, ctx, includeHidden) === false) return false;
    }
    return true;
  }

  // Indexes every element that could be named, so a ref can record "the 2nd of
  // 3 buttons called Delete" and find it again after the page re-renders.
  function scan(ctx) {
    each(document, function (el) {
      var info = infoOf(ctx, el);
      if (info.invisible || info.role === 'none') return;
      if (TRANSPARENT[info.role] && !info.clickable) return;
      var key = keyOf(info.role, info.name);
      var list = ctx.index.get(key);
      if (!list) { list = []; ctx.index.set(key, list); }
      ctx.nth.set(el, list.length);
      list.push(el);
      ctx.all.push(el);
    }, ctx, false);
    return ctx;
  }

  function cssPath(el) {
    var doc = el.ownerDocument;
    if (doc !== document || el.getRootNode() !== doc) return null;
    var parts = [];
    while (el && el.nodeType === 1 && el !== doc.documentElement) {
      if (el.id && doc.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
        parts.unshift('#' + CSS.escape(el.id));
        break;
      }
      var n = 1;
      for (var s = el.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === el.tagName) n++;
      parts.unshift(tagOf(el) + ':nth-of-type(' + n + ')');
      el = el.parentElement;
    }
    return parts.join(' > ');
  }

  // Gives an element its ref, reusing the id of a dead element that had the
  // same role, name and position, so an identical re-render keeps its refs.
  function refFor(ctx, el, info) {
    var st = state();
    var key = keyOf(info.role, info.name);
    var list = ctx.index.get(key);
    var nth = ctx.nth.has(el) ? ctx.nth.get(el) : 0;
    var slot = key + '#' + nth;
    var id = st.ids.get(el);
    if (!id) {
      var cand = st.byKey.get(slot);
      var held = cand ? st.refs.get(cand) : null;
      if (held && !alive(held.el)) id = cand;
      else id = 'e' + st.next++;
      st.ids.set(el, id);
    }
    st.byKey.set(slot, id);
    st.refs.set(id, {
      el: el,
      desc: { tag: info.tag, role: info.role, name: info.name, nth: nth, count: list ? list.length : 1, path: cssPath(el) }
    });
    return id;
  }

  function prune() {
    var st = state();
    st.refs.forEach(function (entry) { if (!alive(entry.el)) entry.el = null; });
    while (st.refs.size > MAX_REFS) st.refs.delete(st.refs.keys().next().value);
  }

  function describeDesc(d) {
    return '<' + d.tag + '>' + (d.role !== d.tag ? ' role ' + d.role : '') + (d.name ? ' "' + d.name + '"' : '');
  }

  // Role and name come first because they say what the element IS. The css
  // path is a last resort for unnamed elements only: a path can land on a
  // different row after a list shifts, and a named element must never be
  // swapped for a neighbour.
  function reResolve(d) {
    var ctx = scan(newCtx());
    var list = ctx.index.get(keyOf(d.role, d.name)) || [];
    // A changed count means the list moved under us, and the nth is a guess.
    if (list.length === d.count && list[d.nth]) return list[d.nth];
    if (d.name || !d.path) return null;
    var el = null;
    try { el = document.querySelector(d.path); } catch (e) { el = null; }
    if (!el || tagOf(el) !== d.tag) return null;
    return infoOf(ctx, el).role === d.role ? el : null;
  }

  function resolveRef(id, soft) {
    var st = state();
    var entry = st.refs.get(id);
    if (!entry) {
      api.last.stale = id;
      if (soft) return [];
      throw new Error('Ref ' + id + ' is unknown on this page: no snapshot issued it here, or the page reloaded or navigated since. Take a new snapshot and use the refs from it.');
    }
    if (alive(entry.el)) return [entry.el];
    var el = reResolve(entry.desc);
    if (!el) {
      api.last.stale = id;
      if (soft) return [];
      throw new Error('Ref ' + id + ' is stale: the ' + describeDesc(entry.desc) + ' it pointed at is gone, and nothing identical was found to take its place. Take a new snapshot to get current refs.');
    }
    entry.el = el;
    st.ids.set(el, id);
    api.last.reResolved = true;
    api.last.ref = id;
    return [el];
  }

  var ROLE_SYNTAX = /^([a-z][a-z0-9_-]*)\s*(?:\[\s*name\s*(~?=)\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\]]*?))\s*\])?$/i;

  function unescapeQuoted(s) { return s.replace(/\\(.)/g, '$1'); }

  function byRole(spec) {
    var m = ROLE_SYNTAX.exec(spec.trim());
    if (!m) {
      throw new Error('Cannot parse the role selector "role=' + spec + '". Use role=button, role=button[name="Save"] for an exact name, or role=button[name~="sav"] for a substring.');
    }
    var role = m[1].toLowerCase();
    var op = m[2];
    var want = m[3] !== undefined ? unescapeQuoted(m[3]) : m[4] !== undefined ? unescapeQuoted(m[4]) : m[5];
    var ctx = scan(newCtx());
    var out = [];
    for (var i = 0; i < ctx.all.length; i++) {
      var info = ctx.cache.get(ctx.all[i]);
      if (info.role !== role) continue;
      if (op === '=' && info.name !== norm(want)) continue;
      if (op === '~=' && info.name.toLowerCase().indexOf(norm(want).toLowerCase()) === -1) continue;
      out.push(ctx.all[i]);
    }
    return out;
  }

  // Same ranking as text=: exact before substring, visible before hidden.
  function rank(hits) {
    var groups = [[], [], [], []];
    for (var i = 0; i < hits.length; i++) {
      groups[(hits[i].exact ? 0 : 2) + (api.visible(hits[i].el) ? 0 : 1)].push(hits[i].el);
    }
    return groups[0].concat(groups[1], groups[2], groups[3]);
  }

  function byTexts(needle, opts, candidates, textsOf) {
    var want = norm(needle).toLowerCase();
    var hits = [];
    for (var i = 0; i < candidates.length; i++) {
      var texts = textsOf(candidates[i]);
      var exact = false;
      var partial = false;
      for (var j = 0; j < texts.length; j++) {
        var t = texts[j].toLowerCase();
        if (t === want) exact = true;
        else if (t.indexOf(want) !== -1) partial = true;
      }
      if (exact || (partial && !opts.exact)) hits.push({ el: candidates[i], exact: exact });
    }
    return rank(hits);
  }

  function everyElement() {
    var list = [];
    each(document, function (el) { list.push(el); }, newCtx(), true);
    return list;
  }

  function semantic(selector, root, opts) {
    var m = /^(ref|role|label|placeholder)=([\s\S]*)$/.exec(selector);
    var kind = m[1];
    var rest = m[2];
    var found;
    if (kind === 'ref') found = resolveRef(rest.trim(), opts.soft === true);
    else if (kind === 'role') found = byRole(rest);
    else if (kind === 'label') {
      found = byTexts(rest, opts, everyElement().filter(function (el) {
        return (el.labels && el.labels.length) || el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby');
      }), labelsText);
    } else {
      found = byTexts(rest, opts, everyElement().filter(function (el) { return el.hasAttribute('placeholder'); }), function (el) {
        return [norm(el.getAttribute('placeholder'))];
      });
    }
    if (root && root !== document && root.contains) found = found.filter(function (el) { return root.contains(el); });
    return found;
  }

  api.semantic = semantic;
  api.sem = {
    MAX_NODES: MAX_NODES, SKIP: SKIP, INLINE: INLINE, FROM_CONTENT: FROM_CONTENT, INTERACTIVE: INTERACTIVE,
    TRANSPARENT: TRANSPARENT, norm: norm, cap: cap, tagOf: tagOf, state: state, kidsOf: kidsOf,
    isHidden: isHidden, newCtx: newCtx, infoOf: infoOf, scan: scan, refFor: refFor, prune: prune
  };
})(A);
`;
