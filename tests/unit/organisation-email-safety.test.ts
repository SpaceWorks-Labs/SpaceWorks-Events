import { beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => vi.stubEnv("MFA_ENCRYPTION_KEY", process.env.MFA_ENCRYPTION_KEY || Buffer.alloc(32, 7).toString("base64")));
import { isBlockedAddress, PrivateAddressError, resolvePublicAddress, resolvePublicAddresses } from "@/lib/net/publicAddress";
import { decryptOrgSecret, encryptOrgSecret } from "@/lib/orgSecrets";
import { senderAddress } from "@/lib/email/transporter";

describe("organisation server addresses", () => {
  it("blocks this host, private networks, link-local and cloud metadata", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.20.0.5", "192.168.1.10", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1", "not-an-ip"]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
    for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });

  it("judges IPv6 forms that embed or reach private networks, as the organisation webhooks do", () => {
    for (const address of [
      "fec0::1", // site-local
      "2002:c0a8:101::1", // 6to4 of 192.168.1.1
      "2002:7f00:1::", // 6to4 of 127.0.0.1
      "2001:0:4136:e378:8000:63bf:3fff:fdd2", // Teredo
      "::ffff:7f00:1", // IPv4-mapped 127.0.0.1, hex form
      "::ffff:169.254.169.254", // IPv4-mapped cloud metadata
      "64:ff9b::a00:1", // NAT64 of 10.0.0.1
      "192.88.99.1", // 6to4 relay anycast
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
    for (const address of ["2002:808:808::1", "64:ff9b::808:808"]) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });

  it("answers every vetted address with its family, for a pinned connection", async () => {
    await expect(resolvePublicAddresses("2606:4700:4700::1111", { allowPrivate: false })).resolves.toEqual([{ address: "2606:4700:4700::1111", family: 6 }]);
    await expect(resolvePublicAddresses("8.8.8.8", { allowPrivate: false })).resolves.toEqual([{ address: "8.8.8.8", family: 4 }]);
    await expect(resolvePublicAddresses("fec0::1", { allowPrivate: false })).rejects.toBeInstanceOf(PrivateAddressError);
    await expect(resolvePublicAddresses("fec0::1", { allowPrivate: true })).resolves.toEqual([{ address: "fec0::1", family: 6 }]);
  });

  it("refuses private addresses in production, however they are written", async () => {
    await expect(resolvePublicAddress("127.0.0.1", { allowPrivate: false })).rejects.toBeInstanceOf(PrivateAddressError);
    await expect(resolvePublicAddress("::ffff:192.168.0.1", { allowPrivate: false })).rejects.toBeInstanceOf(PrivateAddressError);
    await expect(resolvePublicAddress("localhost", { allowPrivate: false })).rejects.toBeInstanceOf(PrivateAddressError);
    await expect(resolvePublicAddress("8.8.8.8", { allowPrivate: false })).resolves.toBe("8.8.8.8");
  });
});

describe("organisation secrets", () => {
  it("round-trips, and fails for another organisation or column", () => {
    const sealed = encryptOrgSecret("org_a", "OrganisationEmailSettings.smtpPasswordEncrypted", "app-password");
    expect(sealed).not.toContain("app-password");
    expect(decryptOrgSecret("org_a", "OrganisationEmailSettings.smtpPasswordEncrypted", sealed)).toBe("app-password");
    expect(() => decryptOrgSecret("org_b", "OrganisationEmailSettings.smtpPasswordEncrypted", sealed)).toThrow();
    expect(() => decryptOrgSecret("org_a", "ChatChannel.secret", sealed)).toThrow();
  });
});

describe("sender address", () => {
  it("takes the address from a configured sender", () => {
    expect(senderAddress("Space Works Events <noreply@events.test>")).toBe("noreply@events.test");
    expect(senderAddress("noreply@events.test")).toBe("noreply@events.test");
  });
});
