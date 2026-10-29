import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return { ...actual, default: { ...actual, lookup: dns.lookup }, lookup: dns.lookup };
});

import { isAllowedOpsWebhook, postOpsWebhook } from "@/lib/opsWebhookAddress";

afterEach(() => {
  vi.unstubAllEnvs();
  dns.lookup.mockReset();
});

/** A local receiver that counts connections and answers 200. */
async function receiver() {
  const bodies: string[] = [];
  let connections = 0;
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      bodies.push(body);
      response.end("ok");
    });
  });
  server.on("connection", () => { connections += 1; });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, bodies, connections: () => connections, close: () => server.close() };
}

describe("alert webhook address", () => {
  it("refuses this host, its network and cloud metadata in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const url of ["https://127.0.0.1/hooks/x", "https://10.0.0.5/hooks/x", "https://169.254.169.254/latest", "https://[::1]/hooks/x", "https://192.168.1.20:8065/hooks/x"]) {
      await expect(isAllowedOpsWebhook(url)).resolves.toBe(false);
    }
  });

  it("accepts a public address", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(isAllowedOpsWebhook("https://93.184.215.14/hooks/x")).resolves.toBe(true);
  });

  it("allows a private chat server only with OPS_WEBHOOK_ALLOW_PRIVATE=1", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OPS_WEBHOOK_ALLOW_PRIVATE", "1");
    await expect(isAllowedOpsWebhook("https://192.168.1.20:8065/hooks/x")).resolves.toBe(true);
  });

  it("refuses a URL it cannot parse", async () => {
    await expect(isAllowedOpsWebhook("not a url")).resolves.toBe(false);
  });
});

describe("alert webhook delivery", () => {
  it("never connects to a host that re-resolves to loopback after it was checked", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const local = await receiver();
    try {
      const url = `https://hooks.example.test:${local.port}/hooks/x`;
      // Public when the super admin saved it; loopback by the time an alert goes out.
      dns.lookup.mockResolvedValueOnce([{ address: "93.184.215.14", family: 4 }]).mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
      await expect(isAllowedOpsWebhook(url)).resolves.toBe(true);
      await expect(postOpsWebhook(url, "{}", 2_000)).resolves.toEqual({ error: "blocked" });
      expect(local.connections()).toBe(0);
    } finally {
      local.close();
    }
  });

  it("connects only to the address it checked, without resolving the name again", async () => {
    const local = await receiver();
    try {
      // The name has no real DNS answer: the request reaches the receiver only through the pinned address.
      dns.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
      await expect(postOpsWebhook(`http://hooks.example.test:${local.port}/hooks/x`, JSON.stringify({ text: "hi" }), 2_000)).resolves.toEqual({ status: 200 });
      expect(dns.lookup).toHaveBeenCalledTimes(1);
      expect(local.bodies).toEqual([JSON.stringify({ text: "hi" })]);
    } finally {
      local.close();
    }
  });

  it("reports a refused connection as unreachable", async () => {
    const local = await receiver();
    local.close();
    await expect(postOpsWebhook(`http://127.0.0.1:${local.port}/hooks/x`, "{}", 2_000)).resolves.toEqual({ error: "unreachable" });
  });
});
