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

  constructor(backend, { newNonce = randomUUID } = {}) {
    this.backend = backend;
    this.newNonce = newNonce;
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
    const marked = await markTab(nonce);
    const targets = await this.backend.listPageTargets();

    // Likely candidates first, but never the only ones: the tab's URL can move
    // between the Apple Event and the target listing (a redirect settling).
    const likely = targets.filter((t) => urlsMatch(t.url, marked?.url));
    const rest = targets.filter((t) => !likely.includes(t));
    for (const group of [likely, rest]) {
      for (const target of group) {
        if ((await this.backend.readMarker(target.targetId)) === nonce) {
          this.#cache.set(tabId, { targetId: target.targetId, nonce });
          return target.targetId;
        }
      }
    }

    throw new MappingError(
      'Could not find this Arc tab on the DevTools port. None of the ' +
        `${targets.length} page target(s) carried the marker that was just written into the tab. ` +
        'Either the port belongs to a different browser than Arc (nothing was driven), or the tab ' +
        'is a page scripts cannot touch (arc://, a new-tab page, a PDF viewer), or it was discarded ' +
        'in the background. Run cdp_status to see what is on the port, and try reloading the tab.'
    );
  }
}
