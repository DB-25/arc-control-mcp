import { SEMANTIC_LIB } from './page-semantic.js';

/**
 * A.snapshot: walks the page into a compact indented text tree of roles, names
 * and refs, so a model can act on what it reads instead of guessing selectors.
 * Built on the helpers in page-semantic.js, which are shipped with it.
 *
 * Same constraints as that file: injected source, so String.raw, no backticks
 * or dollar-brace, and nothing touches the DOM outside a function.
 */
const SNAPSHOT_TREE = String.raw`
(function (api) {
  var S = api.sem;
  var MAX_TEXT = 160;
  var MAX_VALUE = 80;
  var MAX_HREF = 100;
  var MAX_OPTIONS = 20;
  var STATE_ROLES = { checkbox: 1, radio: 1, switch: 1, menuitemcheckbox: 1, menuitemradio: 1 };
  var NO_VALUE = /^(?:checkbox|radio|button|submit|reset|image|file|password|hidden)$/;

  function esc(s) { return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
  function pad(n) { var s = ''; for (var i = 0; i < n; i++) s += '  '; return s; }

  function emitText(ctx, text, depth) {
    var last = ctx.lines[ctx.lines.length - 1];
    // Inline runs ("Hello <b>world</b>") read as one line. A block boundary
    // sets ctx.sep, so two paragraphs never merge.
    if (last && last.kind === 'text' && last.depth === depth && !ctx.sep) {
      last.text += ' ' + text;
      return;
    }
    ctx.lines.push({ kind: 'text', text: text, depth: depth });
    ctx.sep = false;
  }

  function walkKids(ctx, parent, depth, folded) {
    var kids = S.kidsOf(parent);
    for (var i = 0; i < kids.length; i++) walkNode(ctx, kids[i], depth, folded);
  }

  function walkNode(ctx, node, depth, folded) {
    if (node.nodeType === 3) {
      if (folded || ctx.interactive) return;
      var t = S.norm(node.data);
      if (t) emitText(ctx, t, depth);
      return;
    }
    if (node.nodeType !== 1) return;
    var tag = S.tagOf(node);
    if (S.SKIP[tag] || S.isHidden(node)) return;
    if (ctx.seen++ > S.MAX_NODES) { ctx.hit = true; return; }

    var info = S.infoOf(ctx, node);
    var role = info.role;
    var interactive = !!(S.INTERACTIVE[role] || info.clickable);
    var through = info.invisible || role === 'none' || (S.TRANSPARENT[role] && !info.clickable);

    // A label whose control is named from it would only repeat that name.
    if (role === 'label' && node.control) { walkKids(ctx, node, depth, true); return; }
    if (through || (ctx.interactive && !interactive) || (folded && !interactive)) {
      var block = !S.INLINE[tag];
      if (block) ctx.sep = true;
      walkKids(ctx, node, depth, folded);
      if (block) ctx.sep = true;
      return;
    }
    if (tag === 'option' && ctx.interactive) return;
    if (tag === 'option' && ctx.options-- <= 0) { ctx.skipped++; return; }

    var line = { kind: 'node', el: node, info: info, depth: ctx.interactive ? 0 : depth, name: info.name };
    var at = ctx.lines.length;
    ctx.lines.push(line);
    ctx.sep = true;

    if (tag === 'iframe' && !node.contentDocument) line.opaque = true;
    if (ctx.maxDepth !== null && depth >= ctx.maxDepth) {
      if (node.childElementCount || node.shadowRoot) { line.more = true; ctx.limited = true; }
      return;
    }
    if (tag === 'select') { ctx.options = MAX_OPTIONS; ctx.skipped = 0; }
    // A button's text is its name, so only the controls inside it get lines of their own.
    walkKids(ctx, node, depth + 1, !!(S.FROM_CONTENT[role] || info.clickable));
    if (tag === 'select' && ctx.skipped) {
      ctx.lines.push({ kind: 'text', text: '... ' + ctx.skipped + ' more options', depth: depth + 1 });
    }
    // A container that holds one line of text is that text: "listitem" plus
    // 'text "Milk"' reads better as listitem "Milk".
    var only = ctx.lines[at + 1];
    if (!ctx.interactive && !line.name && ctx.lines.length === at + 2 && only.kind === 'text') {
      line.name = only.text;
      ctx.lines.pop();
    }
  }

  function boxOf(el) {
    var r = el.getBoundingClientRect();
    var x = r.left;
    var y = r.top;
    // A frame's coordinates are its own: shift them into the top window's.
    try {
      var win = el.ownerDocument.defaultView;
      while (win && win.frameElement) {
        var f = win.frameElement.getBoundingClientRect();
        x += f.left;
        y += f.top;
        win = win.parent;
      }
    } catch (e) {}
    var inView = r.width > 0 && r.height > 0 && x + r.width > 0 && y + r.height > 0 && x < window.innerWidth && y < window.innerHeight;
    return '[box=' + Math.round(x) + ',' + Math.round(y) + ',' + Math.round(r.width) + ',' + Math.round(r.height) + '] ' + (inView ? '[in-viewport]' : '[offscreen]');
  }

  function valueOf(el, role) {
    var tag = S.tagOf(el);
    if (tag === 'select') {
      var chosen = [];
      for (var i = 0; i < el.selectedOptions.length; i++) chosen.push(S.norm(el.selectedOptions[i].text));
      return chosen.join(', ');
    }
    if (tag === 'input') return NO_VALUE.test(el.type || '') ? '' : el.value;
    if (tag === 'textarea') return el.value;
    if (role === 'slider' || role === 'spinbutton' || role === 'progressbar' || role === 'meter') {
      return el.getAttribute('aria-valuenow') || ('value' in el ? String(el.value) : '');
    }
    return '';
  }

  function statesOf(el, info) {
    var role = info.role;
    var out = [];
    var aria = function (n) { return el.getAttribute(n); };
    if (STATE_ROLES[role]) {
      if (el.indeterminate || aria('aria-checked') === 'mixed') out.push('mixed');
      else if (el.checked === true || aria('aria-checked') === 'true') out.push('checked');
    }
    if (aria('aria-pressed') === 'true') out.push('pressed');
    if (el.selected === true || aria('aria-selected') === 'true') out.push('selected');
    var expanded = aria('aria-expanded');
    if (S.tagOf(el) === 'summary' && el.parentElement) expanded = el.parentElement.open ? 'true' : 'false';
    if (expanded === 'true') out.push('expanded');
    else if (expanded === 'false') out.push('collapsed');
    if (S.INTERACTIVE[role] ? api.disabled(el) : aria('aria-disabled') === 'true') out.push('disabled');
    if (el.required === true || aria('aria-required') === 'true') out.push('required');
    if (el.readOnly === true || aria('aria-readonly') === 'true') out.push('readonly');
    if (aria('aria-invalid') === 'true') out.push('invalid');
    if (el.getRootNode().activeElement === el) out.push('focused');
    return out;
  }

  function lineText(ctx, line) {
    var p = pad(line.depth);
    if (line.kind === 'text') return p + '- text "' + esc(S.cap(line.text, MAX_TEXT)) + '"';
    var el = line.el;
    var info = line.info;
    var s = p + '- ' + info.role;
    if (line.name) s += ' "' + esc(S.cap(line.name, MAX_TEXT)) + '"';
    if (info.role === 'heading') {
      var level = el.getAttribute('aria-level') || (/^h[1-6]$/.test(info.tag) ? info.tag.charAt(1) : '');
      if (level) s += ' [level=' + level + ']';
    }
    s += ' [ref=' + S.refFor(ctx, el, info) + ']';
    if (ctx.boxes) s += ' ' + boxOf(el);
    var value = valueOf(el, info.role);
    if (value) s += ' value="' + esc(S.cap(value, MAX_VALUE)) + '"';
    if (info.role === 'link' && el.getAttribute('href')) s += ' href="' + esc(S.cap(el.getAttribute('href'), MAX_HREF)) + '"';
    var states = statesOf(el, info);
    if (states.length) s += ' (' + states.join(', ') + ')';
    if (line.opaque) s += ' (cross-origin, contents not inspected)';
    if (line.more) s += ' (children omitted: depth limit)';
    return s;
  }

  // Lines present in one snapshot and not the other. Refs are stable, so a
  // changed element shows up as its old line removed and its new line added.
  function diffLines(prev, now) {
    var left = {};
    var i;
    for (i = 0; i < prev.length; i++) left[prev[i]] = (left[prev[i]] || 0) + 1;
    var added = [];
    for (i = 0; i < now.length; i++) {
      if (left[now[i]]) left[now[i]]--;
      else added.push(now[i]);
    }
    var removed = [];
    for (i = 0; i < prev.length; i++) {
      if (left[prev[i]]) { left[prev[i]]--; removed.push(prev[i]); }
    }
    return { added: added, removed: removed };
  }

  function truncate(lines, maxChars) {
    var out = [];
    var used = 0;
    for (var i = 0; i < lines.length; i++) {
      if (used + lines[i].length + 1 > maxChars && out.length) {
        return { text: out.join('\n'), omitted: lines.length - i };
      }
      out.push(lines[i]);
      used += lines[i].length + 1;
    }
    return { text: out.join('\n'), omitted: 0 };
  }

  api.snapshot = function (opts, rootEl) {
    opts = opts || {};
    S.prune();
    var ctx = S.scan(S.newCtx());
    ctx.interactive = opts.interactive === true;
    ctx.maxDepth = typeof opts.depth === 'number' && opts.depth >= 0 ? opts.depth : null;
    ctx.boxes = opts.boxes === true;
    ctx.lines = [];
    ctx.sep = true;
    ctx.seen = 0;
    ctx.options = MAX_OPTIONS;
    ctx.skipped = 0;
    ctx.limited = false;

    if (rootEl) walkNode(ctx, rootEl, 0, false);
    else walkKids(ctx, document, 0, false);

    var lines = [];
    for (var i = 0; i < ctx.lines.length; i++) lines.push(lineText(ctx, ctx.lines[i]));

    var st = S.state();
    var key = JSON.stringify([opts.scopeKey || '', ctx.interactive, ctx.maxDepth, ctx.boxes]);
    var prev = st.last && st.last.key === key ? st.last.lines : null;
    st.last = { key: key, lines: lines };

    var out = {
      url: location.href,
      title: document.title,
      nodes: lines.length,
      refs: st.refs.size,
      depthLimited: ctx.limited || undefined,
      nodeLimitHit: ctx.hit || undefined
    };
    var body = lines;
    if (opts.diff === true) {
      if (!prev) {
        out.diff = 'baseline';
      } else {
        var d = diffLines(prev, lines);
        if (!d.added.length && !d.removed.length) {
          out.diff = 'unchanged';
          out.snapshot = 'unchanged';
          return out;
        }
        out.diff = 'changes';
        out.added = d.added.length;
        out.removed = d.removed.length;
        body = ['## added or changed'].concat(d.added, d.removed.length ? ['## removed'].concat(d.removed) : []);
      }
    }
    if (!body.length) body = ['(nothing to show: the page or scope has no content a reader could see)'];
    var cut = truncate(body, typeof opts.maxChars === 'number' && opts.maxChars > 0 ? opts.maxChars : 20000);
    out.snapshot = cut.text;
    if (cut.omitted) {
      out.truncated = true;
      out.omittedLines = cut.omitted;
      out.snapshot += '\n# truncated: ' + cut.omitted + ' more lines. Narrow with scope, interactive_only or depth, or raise max_chars.';
    }
    return out;
  };
})(A);
`;

export const SNAPSHOT_LIB = SEMANTIC_LIB + SNAPSHOT_TREE;
