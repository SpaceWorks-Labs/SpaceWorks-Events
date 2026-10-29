/**
 * A chunked POST with no Content-Length: the body arrives in pieces, and the
 * helper reports how many pieces were read and whether the reader cancelled.
 */
export function chunkedRequest(url: string, parts: string[], contentType = "application/json") {
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= parts.length) return controller.close();
      controller.enqueue(new TextEncoder().encode(parts[pulled++]));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request(url, { method: "POST", body, headers: { "content-type": contentType }, duplex: "half" } as RequestInit);
  return { request, pulled: () => pulled, cancelled: () => cancelled };
}

/** A JSON object padded past `bytes` and split into 1 KiB chunks. */
export function oversizedJsonParts(bytes: number): string[] {
  const json = JSON.stringify({ padding: "x".repeat(bytes) });
  return Array.from({ length: Math.ceil(json.length / 1024) }, (_, index) => json.slice(index * 1024, (index + 1) * 1024));
}
