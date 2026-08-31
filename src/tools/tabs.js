import { runJxa } from '../jxa.js';
import { TAB_ID, read, write, scoped, runTab, state } from './shared.js';

async function snapshotAll() {
  const result = await runJxa(
    `requireArc();
     const space = agentSpace();
     JSON.stringify({ tabs: snapshot(), agentSpace: space ? { id: space.id(), title: space.title() } : null });`,
    scoped()
  );
  state.reconcile(result.tabs.map((t) => t.id));
  return result;
}

export const tools = [
  {
    name: 'list_tabs',
    description: "List Arc tabs. Rows are flagged 'mine' for tabs this agent opened and 'isActive' for the tab the user is on. Defaults to every tab; pass scope 'own' to narrow.",
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['all', 'own'], description: "'all' (default) or only this agent's tabs", default: 'all' },
        query: { type: 'string', description: 'Case-insensitive substring matched against title and url' },
        space: { type: 'string', description: 'Only tabs in this space title' },
        window_id: { type: 'string', description: 'Restrict to one window id' }
      }
    },
    annotations: read('List Tabs', { openWorld: false })
  },
  {
    name: 'get_current_tab',
    description: "Get the tab a call with no tab_id would act on: this agent's current tab, or the active tab if it has none.",
    inputSchema: { type: 'object', properties: { tab_id: TAB_ID } },
    annotations: read('Get Current Tab', { openWorld: false })
  },
  {
    name: 'switch_to_tab',
    description: 'Make a tab the active tab in its window. Changes what the user sees, so prefer reading a tab by id when you only need its content.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { ...TAB_ID, description: 'Arc tab id from list_tabs' },
        activate: { type: 'boolean', description: 'Also bring Arc to the front', default: false }
      },
      required: ['tab_id']
    },
    annotations: write('Switch To Tab', { idempotent: true, openWorld: false })
  },
  {
    name: 'close_tab',
    description:
      "Close one tab. With no tab_id this closes whatever a bare call resolves to, which is this agent's current tab or, if it has none yet, the tab the user is actively looking at. Pass an explicit tab_id from list_tabs unless you are certain. Closing cannot be undone and tab ids are not reused. To clean up after yourself, prefer close_own_tabs.",
    inputSchema: { type: 'object', properties: { tab_id: TAB_ID } },
    annotations: write('Close Tab', { destructive: true, openWorld: false })
  },
  {
    name: 'close_own_tabs',
    description: "Close every tab this agent opened, leaving the user's tabs alone. Tabs leaked by a previous run of this label are left alone too unless include_stale is set.",
    inputSchema: {
      type: 'object',
      properties: {
        include_stale: {
          type: 'boolean',
          description: 'Also close tabs left behind by dead sessions of this label (see staleTabCount in arc_status). Never touches a live agent\'s tabs.',
          default: false
        }
      }
    },
    annotations: write('Close Own Tabs', { destructive: true, openWorld: false })
  },
  {
    name: 'arc_status',
    description: 'Report Arc state: which tabs this agent owns, whether the agent space exists, what a call with no tab_id resolves to, and how many tabs a previous run of this label left behind.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: read('Arc Status', { openWorld: false })
  }
];

export const handlers = {
  arc_status: async () => {
    const { tabs, agentSpace } = await snapshotAll();
    const owned = new Set(state.ownedIds());
    const active = tabs.find((t) => t.isActive);
    return {
      label: state.label(),
      // Ownership is per session, so two agents can share a label without
      // seeing each other's tabs. The file is where a restart looks for leaks.
      sessionId: state.sessionId(),
      stateFile: state.stateFile(),
      isolation: agentSpace ? 'space' : 'shared-window',
      agentSpace,
      agentSpaceName: state.AGENT_SPACE,
      resolvesTo: state.currentTabId()
        ? { reason: "this agent's current tab", tab: tabs.find((t) => t.id === state.currentTabId()) || null }
        : { reason: 'no agent tab yet, falls back to the active tab', tab: active || null },
      ownTabs: tabs.filter((t) => owned.has(t.id)),
      staleTabCount: state.staleIds().length,
      otherTabCount: tabs.filter((t) => !owned.has(t.id)).length
    };
  },

  list_tabs: async (args) => {
    const { tabs } = await snapshotAll();
    const owned = new Set(state.ownedIds());
    const scope = args.scope || 'all';

    let rows = tabs.map((t) => ({ ...t, mine: owned.has(t.id) }));
    if (scope === 'own') rows = rows.filter((t) => t.mine);
    if (args.window_id) rows = rows.filter((t) => t.windowId === args.window_id);
    if (args.space) rows = rows.filter((t) => t.space === args.space);
    if (args.query) {
      const q = args.query.toLowerCase();
      rows = rows.filter((t) => (t.title || '').toLowerCase().includes(q) || (t.url || '').toLowerCase().includes(q));
    }
    return { scope, count: rows.length, tabs: rows };
  },

  get_current_tab: (args) => runTab(args, `const tab = target(); JSON.stringify(describe(tab));`),

  switch_to_tab: async (args) => {
    const result = await runTab(
      args,
      `const tab = target();
       Arc.select(tab);
       if (P.activate) Arc.activate();
       delay(0.3);
       JSON.stringify({ ok: true, action: "switched", tab: describe(tab) });`
    );
    state.focusOwn(result.tab.id);
    return result;
  },

  close_tab: async (args) => {
    const result = await runTab(
      args,
      `const tab = target();
       const info = describe(tab);
       Arc.close(tab);
       JSON.stringify({ ok: true, action: "closed", tab: info });`
    );
    state.release(result.tab.id);
    return result;
  },

  close_own_tabs: async (args = {}) => {
    // Stale tabs are opt-in: reaping them by default would make every restart
    // destructive, and a recycled pid could make a live sibling look dead.
    const stale = args.include_stale ? state.staleIds() : [];
    const ids = [...new Set([...state.ownedIds(), ...stale])];
    if (ids.length === 0) return { ok: true, closed: 0, note: 'This agent had no tabs open.' };
    const result = await runJxa(
      `requireArc();
       const closed = [];
       for (let i = 0; i < P.ids.length; i++) {
         const tab = locate(P.ids[i]);
         if (!tab) continue;
         closed.push({ id: P.ids[i], title: tab.title() });
         Arc.close(tab);
         delay(0.2);
       }
       JSON.stringify({ closed: closed });`,
      { ids }
    );
    result.closed.forEach((t) => state.release(t.id));
    const staleClosed = result.closed.filter((t) => stale.includes(t.id)).length;
    return {
      ok: true,
      closed: result.closed.length,
      ...(staleClosed > 0 ? { staleClosed } : {}),
      tabs: result.closed
    };
  }
};
