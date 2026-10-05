/**
 * How a handler's return value becomes MCP content. Most results are JSON
 * text. A handler that produced an image (screenshot) sets `__image`, which
 * goes out as image content next to the text, never as base64 inside the JSON.
 */

export function toContent(result) {
  if (!result || typeof result !== 'object' || !result.__image) {
    return [{ type: 'text', text: JSON.stringify(result, null, 2) }];
  }
  const { __image: image, ...rest } = result;
  return [
    { type: 'text', text: JSON.stringify(rest, null, 2) },
    { type: 'image', data: image.data, mimeType: image.mimeType }
  ];
}

/** For callers that can only carry JSON, such as batch: the image is dropped and said to be. */
export function omitImage(result) {
  if (!result || typeof result !== 'object' || !result.__image) return result;
  const { __image, ...rest } = result;
  return { ...rest, imageOmitted: 'Image content cannot travel inside batch. Call this tool directly to receive the image.' };
}
