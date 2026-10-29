/**
 * A request body read with a hard cap, whether or not `Content-Length` was
 * sent (chunked uploads): reading stops, and the stream is cancelled, as soon
 * as the cap is passed. The same pattern as the payment webhooks and
 * POST /api/feedback.
 */
export async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array | "too_large" | "unreadable"> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return "too_large";
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return "too_large";
      }
      chunks.push(part.value);
    }
  } catch {
    return "unreadable";
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * A JSON body read through `readBoundedBody`. An unreadable, empty or
 * malformed body is "invalid", like a failed `request.json()`.
 */
export async function readBoundedJson(request: Request, maxBytes: number): Promise<{ value: unknown } | "too_large" | "invalid"> {
  const bytes = await readBoundedBody(request, maxBytes);
  if (bytes === "too_large") return "too_large";
  if (bytes === "unreadable") return "invalid";
  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
  } catch {
    return "invalid";
  }
}
