/**
 * The non-input CDP operations: screenshots, file uploads and dialogs.
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, sep } from 'node:path';

import { ArcError } from '../jxa.js';
import { PAGE_LIB } from '../page-lib.js';
import { CdpError } from './client.js';
import { locate, fail } from './tab.js';

// Chrome cannot rasterise a surface taller than this in one texture, so a
// longer page is cut here and the result says so.
export const MAX_FULL_PAGE_HEIGHT_PX = 16384;

/** Pixel size straight from the image header, so a result can state it without decoding. */
export function imageSize(base64, format) {
  const bytes = Buffer.from(base64, 'base64');
  if (format === 'png') {
    return bytes.length >= 24 ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : null;
  }
  // JPEG: walk the marker segments to the start-of-frame, which holds the size.
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  return null;
}

export async function screenshot(t, args) {
  const format = args.format ?? 'png';
  const params = { format, fromSurface: true };
  if (format === 'jpeg') params.quality = args.quality ?? 80;
  let scope = 'viewport';
  let truncated;

  // Opt in only: bringing a tab to the front changes what the user sees.
  if (args.activate === true) await t.send('Page.bringToFront');

  if (args.selector) {
    const { found, failure } = await locate(t, args);
    if (failure) return failure;
    scope = 'element';
    params.clip = { x: found.rect.x + found.scroll.x, y: found.rect.y + found.scroll.y, width: found.rect.width, height: found.rect.height, scale: 1 };
    // An element taller than the viewport needs the page rendered past it.
    params.captureBeyondViewport = true;
  } else if (args.full_page) {
    scope = 'full_page';
    const { cssContentSize } = await t.send('Page.getLayoutMetrics');
    const height = Math.min(cssContentSize.height, MAX_FULL_PAGE_HEIGHT_PX);
    if (cssContentSize.height > MAX_FULL_PAGE_HEIGHT_PX) truncated = { pageHeight: Math.round(cssContentSize.height), capturedHeight: height };
    params.clip = { x: 0, y: 0, width: cssContentSize.width, height, scale: 1 };
    params.captureBeyondViewport = true;
  }

  const { data } = await t.send('Page.captureScreenshot', params);
  const size = imageSize(data, format);
  return {
    ok: true,
    scope,
    format,
    ...(size ?? {}),
    bytes: Math.floor((data.length * 3) / 4),
    truncated,
    // The base64 travels as MCP image content, not as JSON text.
    __image: { data, mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png' }
  };
}

// Files a page could use to take over an account or a machine. A model that was
// talked into "uploading" one of these is the case this list is for.
const SENSITIVE_PATHS = [
  '.ssh', '.aws', '.gnupg', '.kube', '.docker', '.config/gcloud', '.config/gh',
  'Library/Keychains', 'Library/Cookies', 'Library/Application Support/Arc',
  'Library/Application Support/Google/Chrome', 'Library/Application Support/Firefox'
];
const SENSITIVE_NAMES = new Set(['.netrc', '.npmrc', '.pypirc', '.git-credentials', '.env']);

/**
 * Absolute, existing, regular files only. Symlinks are resolved first, so a
 * link cannot smuggle in something the checks below would have refused.
 */
export function validateUploadPaths(paths, { home = homedir() } = {}) {
  if (!Array.isArray(paths) || paths.length === 0) throw new ArcError('Give at least one file path.');
  const sensitive = SENSITIVE_PATHS.map((p) => join(home, p) + sep);
  return paths.map((path) => {
    if (!isAbsolute(path)) throw new ArcError(`"${path}" is not an absolute path. Give full paths such as /Users/you/file.pdf; nothing is resolved against a working directory.`);
    if (!existsSync(path)) throw new ArcError(`"${path}" does not exist.`);
    const real = realpathSync(path);
    if (!statSync(real).isFile()) throw new ArcError(`"${path}" is not a regular file. Directories cannot be uploaded.`);
    if (sensitive.some((prefix) => real.startsWith(prefix)) || SENSITIVE_NAMES.has(basename(real))) {
      throw new ArcError(`"${path}" is a credentials or browser-profile file, which a web page must not receive. Refused.`);
    }
    return real;
  });
}

export async function uploadFile(t, args) {
  const files = validateUploadPaths(args.paths);
  const match = JSON.stringify({ exact: args.exact === true });
  const info = await t.page(
    `var els = A.all(${JSON.stringify(args.selector)}, null, ${match});
     var el = els[${args.nth ?? 0}];
     if (!el) return { error: 'no_match', matches: els.length };
     return { matches: els.length, tag: el.tagName.toLowerCase(), type: el.type, multiple: !!el.multiple, disabled: el.matches(':disabled') };`
  );
  if (info.error) return fail(`No element matches ${args.selector}`, { matches: info.matches });
  if (info.tag !== 'input' || info.type !== 'file') {
    return fail(`${args.selector} is a <${info.tag}${info.type ? ` type=${info.type}` : ''}>, not an <input type=file>. Some sites hide the input and show a styled button: select the hidden input itself.`, { matches: info.matches });
  }
  if (info.disabled) return fail(`${args.selector} is a disabled file input, so nothing was uploaded.`);
  if (files.length > 1 && !info.multiple) return fail(`${args.selector} accepts one file, but ${files.length} were given.`);

  // The element is fetched by reference, since DOM.setFileInputFiles needs a handle.
  const { result } = await t.send('Runtime.evaluate', {
    expression: `(function(){${PAGE_LIB} return A.all(${JSON.stringify(args.selector)}, null, ${match})[${args.nth ?? 0}] || null; })()`
  });
  if (!result?.objectId) throw new CdpError('The file input disappeared before the files could be set.', { code: 'gone' });
  try {
    await t.send('DOM.setFileInputFiles', { files, objectId: result.objectId });
    const read = await t.send('Runtime.callFunctionOn', {
      objectId: result.objectId,
      functionDeclaration: 'function(){return Array.prototype.map.call(this.files, function(f){return {name: f.name, size: f.size};});}',
      returnByValue: true
    });
    return { ok: true, matches: info.matches, files: read.result?.value ?? [] };
  } finally {
    t.send('Runtime.releaseObject', { objectId: result.objectId }).catch(() => {});
  }
}

export async function handleDialog(t, args) {
  const pending = t.capture.dialog;
  try {
    await t.send('Page.handleJavaScriptDialog', {
      accept: args.action === 'accept',
      ...(args.prompt_text !== undefined ? { promptText: args.prompt_text } : {})
    });
  } catch (error) {
    if (error instanceof CdpError && /no dialog/i.test(error.message)) {
      return fail('No JavaScript dialog is open on this tab. (A dialog that opened before this server first attached to the tab may not have been seen, but Chrome says there is none.)');
    }
    throw error;
  }
  return { ok: true, action: args.action, handled: pending ?? undefined };
}
