import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backupProblem, readVpsBackupStatus, type VpsBackupStatus } from "@/lib/vpsBackupStatus";

const healthy: VpsBackupStatus = {
  version: 1, lastAttemptAt: "2026-10-20T02:40:00Z", lastStatus: "ok", lastKind: "full",
  lastSuccessAt: "2026-10-20T02:40:00Z", lastFullSuccessAt: "2026-10-20T02:40:00Z", sizeBytes: 1024,
  encrypted: true, offsite: "ok", scheduled: true, keepDays: 14,
};
const now = new Date("2026-10-20T12:00:00Z");

describe("VPS backup status", () => {
  const previous = process.env.SWE_STATUS_DIR;
  afterEach(() => {
    if (previous === undefined) delete process.env.SWE_STATUS_DIR;
    else process.env.SWE_STATUS_DIR = previous;
  });

  it("reads the installer's status file and ignores missing or malformed ones", async () => {
    delete process.env.SWE_STATUS_DIR;
    expect(await readVpsBackupStatus()).toBeNull();
    const directory = mkdtempSync(path.join(tmpdir(), "swe-status-"));
    try {
      process.env.SWE_STATUS_DIR = directory;
      expect(await readVpsBackupStatus()).toBeNull();
      writeFileSync(path.join(directory, "backup.json"), `${JSON.stringify(healthy)}\n`);
      expect(await readVpsBackupStatus()).toEqual(healthy);
      writeFileSync(path.join(directory, "backup.json"), JSON.stringify({ ...healthy, lastStatus: "maybe" }));
      expect(await readVpsBackupStatus()).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports each failure once and stale scheduled backups once a day", () => {
    expect(backupProblem(null, now)).toBeNull();
    expect(backupProblem(healthy, now)).toBeNull();
    const failed = backupProblem({ ...healthy, lastStatus: "failed", lastAttemptAt: "2026-10-20T02:31:00Z" }, now);
    expect(failed).toMatchObject({ key: "failed:2026-10-20T02:31:00Z", subject: "Backup failed" });
    expect(backupProblem({ ...healthy, lastStatus: "failed", offsite: "failed" }, now)?.subject).toBe("Backup could not be copied off-site");
    const stale = { ...healthy, lastFullSuccessAt: "2026-10-18T02:40:00Z", lastSuccessAt: "2026-10-18T02:40:00Z" };
    expect(backupProblem(stale, now)?.key).toBe("stale:2026-10-20");
    // Backups run by hand are never called stale.
    expect(backupProblem({ ...stale, scheduled: false }, now)).toBeNull();
  });
});

describe("VPS backup refusals", () => {
  it("names a backup refused because encryption is not working", () => {
    const refused = { ...healthy, lastStatus: "failed" as const, encrypted: false, lastAttemptAt: "2026-10-20T02:31:00Z" };
    const missing = backupProblem({ ...refused, reason: "encryption-key-missing" }, now);
    expect(missing).toMatchObject({ key: "failed:2026-10-20T02:31:00Z", subject: "Backups refused: encryption is not working" });
    expect(missing?.detail).toContain("no encryption key is saved");
    expect(backupProblem({ ...refused, reason: "encryption-unavailable" }, now)?.detail).toContain('Install the "age" package');
    // Status files from older releases have no reason.
    expect(backupProblem({ ...refused, reason: null }, now)?.subject).toBe("Backup failed");
  });
});
