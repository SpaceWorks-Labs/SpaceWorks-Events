import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

const resolved = vi.hoisted(() => ({ addresses: vi.fn() }));
vi.mock("@/lib/net/publicAddress", () => ({ resolvePublicAddresses: resolved.addresses }));

import { describeChatTarget, parseChatConfig } from "@/lib/chat/config";
import { ChatDeliveryError, sendChatMessage } from "@/lib/chat/send";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const ok = () => new Response(null, { status: 200 });

describe("chat connection details", () => {
  it("accepts only each service's own webhook hosts", () => {
    expect(parseChatConfig("SLACK", { url: "https://hooks.slack.com/services/T000/B000/abc" }).ok).toBe(true);
    expect(parseChatConfig("SLACK", { url: "https://evil.example/services/T000/B000/abc" }).ok).toBe(false);
    expect(parseChatConfig("DISCORD", { url: "https://discord.com/api/webhooks/123/abc-DEF_9" }).ok).toBe(true);
    expect(parseChatConfig("DISCORD", { url: "http://discord.com/api/webhooks/123/abc" }).ok).toBe(false);
    expect(parseChatConfig("MATTERMOST", { url: "https://chat.example.org/hooks/abc123" }).ok).toBe(true);
    expect(parseChatConfig("TELEGRAM", { token: "123456:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789", chatId: "-1001234567" }).ok).toBe(true);
    expect(parseChatConfig("WHATSAPP", { phoneNumberId: "1234567890", token: "x".repeat(40), to: ["+919876543210"] }).ok).toBe(true);
    expect(parseChatConfig("WHATSAPP", { phoneNumberId: "1234567890", token: "x".repeat(40), to: [] }).ok).toBe(false);
  });

  it("describes where a chat posts without its secret path or token", () => {
    expect(describeChatTarget("SLACK", { url: "https://hooks.slack.com/services/T000/B000/secret" })).toBe("hooks.slack.com");
    expect(describeChatTarget("WHATSAPP", { phoneNumberId: "1", token: "t", to: ["+919876543210"] })).toBe("…3210");
  });
});

describe("sending", () => {
  it("posts plain text to Slack, and to Discord with mentions switched off", async () => {
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    await sendChatMessage("SLACK", { url: "https://hooks.slack.com/services/T/B/x" }, "Hello");
    await sendChatMessage("DISCORD", { url: "https://discord.com/api/webhooks/1/x" }, "@everyone hi");
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(((call as unknown) as [string, RequestInit])[1].body as string));
    expect(bodies[0]).toEqual({ text: "Hello" });
    expect(bodies[1]).toEqual({ content: "@everyone hi", allowed_mentions: { parse: [] } });
    expect(((fetchMock.mock.calls[0] as unknown) as [string, RequestInit])[1].redirect).toBe("error");
  });

  it("uses a WhatsApp template when one is set, for each number", async () => {
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    await sendChatMessage("WHATSAPP", { phoneNumberId: "555", token: "tok".repeat(10), to: ["+911111111111", "+922222222222"], template: "event_update", language: "en" }, "New booking");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = (fetchMock.mock.calls[0] as unknown) as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v21.0/555/messages");
    expect(JSON.parse(init.body as string)).toMatchObject({ to: "911111111111", type: "template", template: { name: "event_update", components: [{ parameters: [{ text: "New booking" }] }] } });
  });

  it("treats a rejected webhook as permanent and rate limits as temporary", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    await expect(sendChatMessage("SLACK", { url: "https://hooks.slack.com/services/T/B/x" }, "x")).rejects.toMatchObject({ permanent: true });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 429 })));
    await expect(sendChatMessage("SLACK", { url: "https://hooks.slack.com/services/T/B/x" }, "x")).rejects.toBeInstanceOf(ChatDeliveryError);
    await expect(sendChatMessage("SLACK", { url: "https://hooks.slack.com/services/T/B/x" }, "x")).rejects.toMatchObject({ permanent: false });
  });

  it("never connects to a Mattermost server on a private address", async () => {
    resolved.addresses.mockRejectedValue(new (class PrivateAddressError extends Error {})("private"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(sendChatMessage("MATTERMOST", { url: "https://chat.internal.example/hooks/abc" }, "x")).rejects.toThrow("private");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("connects a Mattermost host name to its vetted address when Node asks the lookup for every address", async () => {
    // Node's default family autoselection calls the lookup with `all: true`, which needs an array answer.
    expect(net.getDefaultAutoSelectFamily()).toBe(true);
    const connections: string[] = [];
    const server = net.createServer((socket) => {
      connections.push(socket.remoteAddress ?? "");
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    resolved.addresses.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    try {
      // A plain TCP server: reaching it proves the pinned lookup answered (the name itself never resolves); TLS then fails.
      await expect(sendChatMessage("MATTERMOST", { url: `https://chat.example.test:${port}/hooks/abc` }, "x")).rejects.toBeInstanceOf(ChatDeliveryError);
      expect(connections).toHaveLength(1);
      expect(resolved.addresses).toHaveBeenCalledWith("chat.example.test");
    } finally {
      server.close();
    }
  });

  it("gives up on a Mattermost host whose DNS answer never comes, at the ten-second deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    resolved.addresses.mockReturnValue(new Promise(() => {}));
    const sending = sendChatMessage("MATTERMOST", { url: "https://chat.example.test/hooks/abc" }, "x");
    const outcome = expect(sending).rejects.toMatchObject({ message: "The chat service did not answer in time.", permanent: false });
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;
  });

  it("gives up on a Mattermost server that never completes the connection, closing the socket", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let closed!: () => void;
    let greeted!: () => void;
    const socketClosed = new Promise<void>((resolve) => { closed = resolve; });
    const handshakeStarted = new Promise<void>((resolve) => { greeted = resolve; });
    // A plain TCP server that takes the TLS greeting and never answers it.
    const server = net.createServer((socket) => {
      socket.once("data", () => greeted());
      socket.on("error", () => {});
      socket.on("close", () => closed());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    resolved.addresses.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    try {
      const sending = sendChatMessage("MATTERMOST", { url: `https://chat.example.test:${port}/hooks/abc` }, "x");
      const outcome = expect(sending).rejects.toMatchObject({ message: "The chat service did not answer in time." });
      await handshakeStarted;
      await vi.advanceTimersByTimeAsync(10_000);
      await outcome;
      vi.useRealTimers();
      await socketClosed;
    } finally {
      server.close();
    }
  });
});
