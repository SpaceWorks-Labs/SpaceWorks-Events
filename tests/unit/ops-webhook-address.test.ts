import http from "node:http";
import net, { type AddressInfo } from "node:net";
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

/**
 * A raw TCP receiver that answers every request with `reply`, writing
 * `drip` every 25 ms forever, and reports when the client's socket closes.
 */
async function stallingReceiver(reply: string, drip: string) {
  let closed!: () => void;
  const socketClosed = new Promise<void>((resolve) => { closed = resolve; });
  const server = net.createServer((socket) => {
    socket.once("data", () => {
      socket.write(reply);
      const timer = setInterval(() => socket.write(drip), 25);
      socket.on("close", () => { clearInterval(timer); closed(); });
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, socketClosed, close: () => server.close() };
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

  it("gives up at the deadline on a server that sends its headers a byte at a time, and closes the socket", async () => {
    const slow = await stallingReceiver("HTTP/1.1 200 OK\r\n", "x");
    try {
      const started = Date.now();
      await expect(postOpsWebhook(`http://127.0.0.1:${slow.port}/hooks/x`, "{}", 400)).resolves.toEqual({ error: "timeout" });
      expect(Date.now() - started).toBeLessThan(2_000);
      await slow.socketClosed;
    } finally {
      slow.close();
    }
  });

  it("returns the status of a reply whose body never ends, and closes the socket without reading it", async () => {
    const endless = await stallingReceiver("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n", "1\r\nx\r\n");
    try {
      await expect(postOpsWebhook(`http://127.0.0.1:${endless.port}/hooks/x`, "{}", 30_000)).resolves.toEqual({ status: 200 });
      await endless.socketClosed;
    } finally {
      endless.close();
    }
  });

  it("counts a DNS answer that never comes against the same deadline", async () => {
    dns.lookup.mockReturnValue(new Promise(() => {}));
    const started = Date.now();
    await expect(postOpsWebhook("https://hooks.example.test/hooks/x", "{}", 300)).resolves.toEqual({ error: "timeout" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("reports a refused connection as unreachable", async () => {
    const local = await receiver();
    local.close();
    await expect(postOpsWebhook(`http://127.0.0.1:${local.port}/hooks/x`, "{}", 2_000)).resolves.toEqual({ error: "unreachable" });
  });
});
