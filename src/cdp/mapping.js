/**
 * Which CDP target is this Arc tab?
 *
 * Arc's tab ids exist only in Apple Events and CDP's target ids only on the
 * DevTools port. URL and title are not a key: two tabs on the same page are
 * routine. So the Arc side writes a one-time random nonce into the page's DOM
 * (the DOM is shared with Arc's isolated scripting world), and the CDP side
 * looks for it. A target is used only if it carries the nonce.
 *
 * That is also the safety property for a default-on engine: a different
 * Chromium that happens to listen on the same port can never be mistaken for
 * Arc, because none of its pages can contain a nonce Arc just generated.
 */
import { randomUUID } from 'node:crypto';

import { ArcError } from '../jxa.js';

export const MARKER_ATTRIBUTE = 'data-arc-mcp-tab';

export class MappingError extends ArcError {}

/** Compare URLs the way a tab strip would: ignore the fragment and a bare trailing slash. */
export function normalizeUrl(url) {
  if (!url) return '';
  return String(url).split('#')[0].replace(/\/$/, '');
}

export const urlsMatch = (a, b) => normalizeUrl(a) !== '' && normalizeUrl(a) === normalizeUrl(b);

// A redirect or a late client-side navigation can move the page between the
// Apple Event that marked it and the target listing. One short wait and one
// repeat covers that without probing anything else.
export const RETRY_WAIT_MS = 400;

/**
 * `backend` is the CDP side, injected so the logic runs against fakes:
 *   listPageTargets(): Promise<[{ targetId, url, title }]>
 *   readMarker(targetId): Promise<string | null>   (null when unreadable or absent)
 * `markTab(nonce)` is the Arc side: write the nonce into the tab's DOM and
 * return { url } for the tab as it is now.
 */
export class TabMapper {
  #cache = new Map();
  #inflight = new Map();

  /**
   * `isBlocked(url)` says whether the guardrails forbid touching a page at that
   * address. Probing means attaching to the page and running a script in it, so
   * such a target is never probed, whatever its URL says about the tab.
   */
  constructor(backend, { newNonce = randomUUID, isBlocked = () => false, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
    this.backend = backend;
    this.newNonce = newNonce;
    this.isBlocked = isBlocked;
    this.sleep = sleep;
  }

  /** Cached target id for a tab, without validating it. */
  cached(tabId) {
    return this.#cache.get(tabId)?.targetId ?? null;
  }

  forget(tabId) {
    this.#cache.delete(tabId);
  }

  clear() {
    this.#cache.clear();
  }

  /** Concurrent calls for one tab share a single mapping, so they cannot overwrite each other's nonce. */
  resolve(tabId, markTab) {
    const running = this.#inflight.get(tabId);
    if (running) return running;
    const promise = this.#resolve(tabId, markTab).finally(() => this.#inflight.delete(tabId));
    this.#inflight.set(tabId, promise);
    return promise;
  }

  async #resolve(tabId, markTab) {
    const hit = this.#cache.get(tabId);
    if (hit) {
      // Revalidated on every use: a navigation drops the attribute, and a
      // closed tab's target is gone. Either way the cache entry is stale.
      if ((await this.backend.readMarker(hit.targetId)) === hit.nonce) return hit.targetId;
      this.#cache.delete(tabId);
    }

    const nonce = this.newNonce();
    const probed = { checked: new Set(), blocked: new Set(), listed: 0 };
    // Only targets at the tab's own address are probed. Attaching to every
    // page and evaluating in it would run a script in tabs this call has
    // nothing to do with, on origins the user never asked to touch.
    const attempt = async (marked) => {
      const targets = await this.backend.listPageTargets();
      probed.listed = targets.length;
      for (const target of targets.filter((t) => urlsMatch(t.url, marked?.url))) {
        if (this.isBlocked(target.url)) {
          probed.blocked.add(target.targetId);
          continue;
        }
        probed.checked.add(target.targetId);
        if ((await this.backend.readMarker(target.targetId)) === nonce) {
          this.#cache.set(tabId, { targetId: target.targetId, nonce });
          return target.targetId;
        }
      }
      return null;
    };

    const first = await attempt(await markTab(nonce));
    if (first) return first;
    // Marking again is harmless (the same nonce) and reports where the tab is now.
    await this.sleep(RETRY_WAIT_MS);
    const second = await attempt(await markTab(nonce));
    if (second) return second;

    if (probed.checked.size === 0 && probed.blocked.size > 0) {
      throw new MappingError(
        `The DevTools target for this tab is on an origin the guardrails block (ARC_MCP_ALLOWED_ORIGINS or ARC_MCP_BLOCKED_ORIGINS), so it was not probed and nothing was driven.`
      );
    }
    throw new MappingError(
      'Could not find this Arc tab on the DevTools port. ' +
        `${probed.checked.size} page target(s) at the tab's address were checked (of ${probed.listed} on the port) and none carried the marker that was just written into the tab. ` +
        'Either the port belongs to a different browser than Arc (nothing was driven), or the tab ' +
        'is a page scripts cannot touch (arc://, a new-tab page, a PDF viewer), or it was discarded ' +
        'in the background, or it navigated while this was looking. Run cdp_status to see what is on the port, and try reloading the tab.'
    );
  }
}
