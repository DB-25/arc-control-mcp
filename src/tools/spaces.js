import { read, write, runTab } from './shared.js';

export const tools = [
  {
    name: 'list_spaces',
    description: 'List Arc spaces in the front window, with tab counts and which is active. Tabs pinned to the top of the sidebar (location topApp) belong to no space, so the reported tabsInSpaces plus topAppCount is what reconciles with totalTabs. Counts cover the front window only, while list_tabs covers every window.',
    inputSchema: { type: 'object', properties: {} },
    annotations: read('List Spaces')
  },
  {
    name: 'focus_space',
    description: "Switch the front Arc window to a space. This changes what the user sees, so it is rarely needed: tabs in an unfocused space are still fully readable and scriptable.",
    inputSchema: {
      type: 'object',
      properties: { space: { type: 'string', description: 'Space id or title from list_spaces' } },
      required: ['space']
    },
    annotations: write('Focus Space')
  }
];

export const handlers = {
  list_spaces: (args) =>
    runTab(
      args,
      `requireArc();
       const w = mainWindow();
       const activeId = w.activeSpace.id();
       const spaces = [];
       let tabsInSpaces = 0;
       for (let i = 0; i < w.spaces.length; i++) {
         const s = w.spaces[i];
         const tabCount = s.tabs.length;
         tabsInSpaces += tabCount;
         spaces.push({
           id: s.id(),
           title: s.title(),
           tabCount: tabCount,
           isActive: s.id() === activeId,
           isAgentSpace: s.title() === P.agent_space
         });
       }
       // space.tabs excludes topApp favourites, so the per-space counts alone
       // never add up to what list_tabs reports. Carry the missing number.
       const locations = w.tabs.location();
       let topAppCount = 0;
       for (let k = 0; k < locations.length; k++) if (locations[k] === "topApp") topAppCount++;
       JSON.stringify({
         windowId: w.id(),
         agentSpaceName: P.agent_space,
         totalTabs: locations.length,
         tabsInSpaces: tabsInSpaces,
         topAppCount: topAppCount,
         spaces: spaces
       });`
    ),

  focus_space: (args) =>
    runTab(
      args,
      `requireArc();
       const space = findSpace(P.space);
       if (!space) throw new Error("SPACE_NOT_FOUND:" + P.space);
       Arc.focus(space);
       delay(0.3);
       JSON.stringify({ ok: true, action: "focused space", space: { id: space.id(), title: space.title() } });`
    )
};
