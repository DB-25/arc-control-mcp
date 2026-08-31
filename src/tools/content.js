import { TAB_ID, SELECTOR, VERBOSE, read, runPage } from './shared.js';

const DEFAULT_MAX_CHARS = 20000;
const DEFAULT_ELEMENT_LIMIT = 40;
const DEFAULT_LINK_LIMIT = 100;

// A blank line between joined element texts, so paragraph boundaries survive.
const PARAGRAPH_GAP = '\n\n';
// Cannot occur in an href or in visible text, so it is a safe key joiner.
const DEDUPE_SEP = '\u0000';

export const tools = [
  {
    name: 'get_page_content',
    description:
      'Get the visible text of a page, or of every element matching a selector joined with blank lines. Always reports "matched", so a partial answer is never silent. Nested matches repeat their text, so prefer a leaf-ish selector.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: TAB_ID,
        selector: SELECTOR,
        first_only: { type: 'boolean', description: 'Return only the first match instead of joining all of them', default: false },
        max_chars: { type: 'number', description: 'Truncate the joined text at this length', default: DEFAULT_MAX_CHARS }
      }
    },
    annotations: read('Get Page Content')
  },
  {
    name: 'get_html',
    description:
      'Get the HTML of a page or element. Use when you need markup, attributes or structure rather than text. Returns one element only: it reports how many matched and takes nth to pick a different one.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: TAB_ID,
        selector: SELECTOR,
        nth: { type: 'number', description: 'Which match to return when several exist, 0-based', default: 0 },
        outer: { type: 'boolean', description: 'Include the element tag itself', default: true },
        max_chars: { type: 'number', description: 'Truncate at this length', default: DEFAULT_MAX_CHARS }
      }
    },
    annotations: read('Get HTML')
  },
  {
    name: 'query_elements',
    description:
      'Find elements and return structured details: text, value, href, visibility, disabled state and attributes. The main way to see what is on a page before acting on it. "text=" matching is substring, with exact matches ranked first; pass exact to require an exact match.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: TAB_ID,
        selector: SELECTOR,
        limit: { type: 'number', description: 'Maximum elements to return', default: DEFAULT_ELEMENT_LIMIT },
        visible_only: { type: 'boolean', description: 'Skip hidden elements', default: false },
        exact: { type: 'boolean', description: 'For a "text=" selector, match the whole text rather than a substring', default: false },
        verbose: VERBOSE
      },
      required: ['selector']
    },
    annotations: read('Query Elements')
  },
  {
    name: 'get_links',
    description:
      'List links on the page with their text and resolved href. Pass unique to collapse repeated href and text pairs, which navigation and footers produce in bulk.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: TAB_ID,
        query: { type: 'string', description: 'Case-insensitive substring matched against link text and href' },
        unique: { type: 'boolean', description: 'Collapse links with an identical href and text, reporting how many were dropped', default: false },
        limit: { type: 'number', description: 'Maximum links to return', default: DEFAULT_LINK_LIMIT }
      }
    },
    annotations: read('Get Links')
  },
  {
    name: 'get_page_info',
    description: 'Page overview: title, url, ready state, meta description, headings, form and frame counts. Cheap orientation before deciding what to do.',
    inputSchema: { type: 'object', properties: { tab_id: TAB_ID } },
    annotations: read('Get Page Info')
  }
];

export const handlers = {
  get_page_content: async (args) => {
    const limit = args.max_chars ?? DEFAULT_MAX_CHARS;
    const firstOnly = args.first_only === true;
    const { result, tab } = await runPage(
      args,
      `var sel = ${JSON.stringify(args.selector || null)};
       var limit = ${limit};
       // documentElement covers a document whose body has not parsed yet.
       var els = sel ? A.all(sel) : [document.body || document.documentElement];
       if (!els.length) return A.miss(sel);
       var take = ${firstOnly} ? 1 : els.length;
       var parts = [];
       for (var i = 0; i < els.length && parts.length < take; i++) parts.push(els[i].innerText || '');
       var text = parts.join(${JSON.stringify(PARAGRAPH_GAP)});
       return {
         text: text.slice(0, limit),
         length: text.length,
         truncated: text.length > limit,
         matched: els.length,
         returned: parts.length
       };`
    );
    if (result?.error === 'no_match') return { error: `No element matches ${args.selector}`, tab };
    if (firstOnly && result.matched > 1) {
      const note = `first_only: this is 1 of ${result.matched} matches for "${args.selector}". Omit first_only to join them all.`;
      return { ...result, note, tab };
    }
    return { ...result, tab };
  },

  get_html: async (args) => {
    const limit = args.max_chars ?? DEFAULT_MAX_CHARS;
    const nth = args.nth ?? 0;
    const { result, tab } = await runPage(
      args,
      `var sel = ${JSON.stringify(args.selector || null)};
       var limit = ${limit};
       var els = sel ? A.all(sel) : [document.documentElement];
       var el = els[${nth}];
       if (!el) return { error: 'no_match', matched: els.length };
       var html = ${args.outer === false ? 'el.innerHTML' : 'el.outerHTML'} || '';
       return {
         html: html.slice(0, limit),
         length: html.length,
         truncated: html.length > limit,
         matched: els.length,
         nth: ${nth}
       };`
    );
    if (result?.error === 'no_match') {
      // "nothing matched" and "nth is past the end" look alike to the page but
      // need different fixes, so name which one happened.
      const error = result.matched
        ? `nth ${nth} is out of range: ${result.matched} element(s) match ${args.selector}`
        : `No element matches ${args.selector}`;
      return { error, matched: result.matched, tab };
    }
    if (result.matched > 1) {
      const note = `${result.matched} elements match "${args.selector}" and this is nth ${nth}. Narrow the selector, or pass nth for another. Use get_page_content for the text of all of them.`;
      return { ...result, note, tab };
    }
    return { ...result, tab };
  },

  query_elements: async (args) => {
    const { result, tab } = await runPage(
      args,
      `var els = A.all(${JSON.stringify(args.selector)}, null, { exact: ${args.exact === true} });
       var out = [];
       for (var i = 0; i < els.length && out.length < ${args.limit ?? DEFAULT_ELEMENT_LIMIT}; i++) {
         var d = A.describe(els[i], ${args.verbose === true});
         if (${args.visible_only === true} && !d.visible) continue;
         d.index = i;
         out.push(d);
       }
       return { total: els.length, returned: out.length, elements: out };`
    );
    return { ...result, selector: args.selector, tab };
  },

  get_links: async (args) => {
    const { result, tab } = await runPage(
      args,
      `var q = ${JSON.stringify((args.query || '').toLowerCase())};
       var unique = ${args.unique === true};
       var limit = ${args.limit ?? DEFAULT_LINK_LIMIT};
       var links = document.querySelectorAll('a[href]');
       var out = [];
       var seen = {};
       var matched = 0;
       var collapsed = 0;
       // Scans every anchor even once the limit is hit, so the counts describe
       // the page rather than the first slice of it.
       for (var i = 0; i < links.length; i++) {
         var a = links[i];
         var text = (a.innerText || a.getAttribute('aria-label') || '').trim();
         var href = a.href;
         if (q && (text + ' ' + href).toLowerCase().indexOf(q) === -1) continue;
         matched++;
         if (unique) {
           var key = href + ${JSON.stringify(DEDUPE_SEP)} + text;
           if (seen[key]) { collapsed++; continue; }
           seen[key] = 1;
         }
         if (out.length >= limit) continue;
         out.push({ text: text.slice(0, 200), href: href, visible: A.visible(a) });
       }
       return { total: links.length, matched: matched, collapsed: collapsed, returned: out.length, links: out };`
    );
    return { ...result, tab };
  },

  get_page_info: async (args) => {
    const { result, tab } = await runPage(
      args,
      `function meta(name) {
         var m = document.querySelector('meta[name="' + name + '"], meta[property="og:' + name + '"]');
         return m ? m.content : null;
       }
       var hs = [];
       var nodes = document.querySelectorAll('h1,h2,h3');
       for (var i = 0; i < nodes.length && hs.length < 30; i++) {
         var t = (nodes[i].innerText || '').trim();
         if (t) hs.push({ level: nodes[i].tagName.toLowerCase(), text: t.slice(0, 150) });
       }
       return {
         title: document.title,
         url: location.href,
         ready: document.readyState,
         description: meta('description'),
         headings: hs,
         counts: {
           links: document.querySelectorAll('a[href]').length,
           forms: document.forms.length,
           inputs: document.querySelectorAll('input,textarea,select').length,
           buttons: document.querySelectorAll('button,[role=button]').length,
           iframes: document.querySelectorAll('iframe').length
         },
         textLength: (document.body ? document.body.innerText : '').length
       };`
    );
    return { ...result, tab };
  }
};
