import { describe, expect, it } from "vitest";
import { readBoundedBody } from "@/lib/mobile/boundedBody";
import { readFormBody, readJsonBody } from "@/lib/mobile/http";

/** A chunked request: no Content-Length, the body arrives in pieces. */
function chunked(parts: string[], contentType = "application/json") {
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
  const request = new Request("https://events.example.test/api/mobile/v1/x", { method: "POST", body, headers: { "content-type": contentType }, duplex: "half" } as RequestInit);
  return { request, pulled: () => pulled, cancelled: () => cancelled };
}

describe("bounded mobile request bodies", () => {
  it("stops reading a chunked body without Content-Length at the cap", async () => {
    const stream = chunked(Array.from({ length: 100 }, () => "x".repeat(1024)));
    await expect(readBoundedBody(stream.request, 4 * 1024)).resolves.toBe("too_large");
    expect(stream.pulled()).toBeLessThan(10);
    expect(stream.cancelled()).toBe(true);
  });

  it("answers 413 in the standard envelope for JSON past the cap, chunked or declared", async () => {
    const response = await readJsonBody(chunked(["{\"a\":\"", "y".repeat(3000), "\"}"]).request, 1024);
    expect("response" in response && response.response.status).toBe(413);
    if ("response" in response) await expect(response.response.json()).resolves.toEqual({ ok: false, error: { code: "PAYLOAD_TOO_LARGE", message: "Request is too large." } });
    const declared = new Request("https://events.example.test/x", { method: "POST", body: "{}", headers: { "content-length": "999999" } });
    const refused = await readJsonBody(declared, 1024);
    expect("response" in refused && refused.response.status).toBe(413);
  });

  it("still reads a small chunked JSON body", async () => {
    await expect(readJsonBody(chunked(["{\"a\":", "1}"]).request)).resolves.toEqual({ value: { a: 1 } });
  });

  it("caps multipart uploads the same way and parses a form under the cap", async () => {
    const boundary = "----swboundary";
    const part = (name: string, value: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    const small = chunked([part("amount", "250"), part("category", "TRAVEL"), `--${boundary}--\r\n`], `multipart/form-data; boundary=${boundary}`);
    const parsed = await readFormBody(small.request, 64 * 1024);
    expect("form" in parsed && parsed.form.get("amount")).toBe("250");
    const large = chunked([part("receipts", "z".repeat(70 * 1024)), `--${boundary}--\r\n`], `multipart/form-data; boundary=${boundary}`);
    const refused = await readFormBody(large.request, 64 * 1024);
    expect("response" in refused && refused.response.status).toBe(413);
    const notMultipart = await readFormBody(chunked(["{}"]).request, 64 * 1024);
    expect("response" in notMultipart && notMultipart.response.status).toBe(400);
  });
});
