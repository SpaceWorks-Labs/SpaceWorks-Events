import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupProblem, readVpsBackupStatus } from "@/lib/vpsBackupStatus";

/*
 * Scripted dry runs of backup encryption handling with fake age, id and
 * docker on PATH: a backup is refused (and the refusal recorded) while
 * encryption is on or requested but not working, and setup withholds the
 * nightly timer in that case. Nothing touches the real system.
 */
const root = path.resolve(import.meta.dirname, "../..");
const recipient = `age1${"q".repeat(58)}`;
let dir = "";
let config = "";

// Paths as bash sees them (Git Bash on Windows needs /c/... in PATH).
const posix = (value: string) => value.replaceAll("\\", "/").replace(/^([A-Za-z]):\//, (_, drive: string) => `/${drive.toLowerCase()}/`);
const bin = (name: string, body: string) => writeFileSync(path.join(dir, "bin", name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
const bash = (script: string, env: Record<string, string> = {}) => spawnSync("bash", ["-c", `PATH="${posix(dir)}/bin:$PATH"; ${script}`], {
  cwd: root, encoding: "utf8",
  env: { ...process.env, FAKE: posix(dir), SWE_DIR: `${posix(dir)}/no-install`, SWE_CONFIG_DIR: posix(config), ...env },
});
const settings = (lines: string[]) => writeFileSync(path.join(config, "backup.env"), lines.map((line) => `${line}\n`).join(""));
const status = () => JSON.parse(readFileSync(path.join(config, "status", "backup.json"), "utf8")) as Record<string, unknown>;
const working = () => bin("age", 'cat > /dev/null; echo "age-encrypted"');
const broken = () => bin("age", "exit 1");

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "swe-backup-encryption-"));
  config = path.join(dir, "config");
  mkdirSync(path.join(dir, "bin"));
  mkdirSync(config);
  writeFileSync(path.join(config, "compose.env"), "SWE_VERSION='1.0.0'\n");
  bin("id", '[ "$1" = -u ] && echo 0 || exit 1');
  // The first step of a real backup: reaching it proves the refusal did not trigger.
  bin("docker", 'echo docker-called >> "$FAKE/docker.log"; exit 1');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("backup encryption", { timeout: 30_000 }, () => {
  it("tells a working age setup from a missing key or a failing age", () => {
    const problem = (key: string) => bash(`. scripts/vps-lib.sh; backup_encryption_problem '${key}'`).stdout;
    working();
    expect(problem(recipient)).toBe("");
    expect(problem("")).toBe("encryption-key-missing");
    broken();
    expect(problem(recipient)).toBe("encryption-unavailable");
  });

  it.each([
    ["requested but no key saved", ["BACKUP_ENCRYPTION='requested'"], working, "encryption-key-missing"],
    ["on, with age failing", [`BACKUP_AGE_RECIPIENT='${recipient}'`], broken, "encryption-unavailable"],
    ["requested, with age failing", ["BACKUP_ENCRYPTION='requested'", `BACKUP_AGE_RECIPIENT='${recipient}'`], broken, "encryption-unavailable"],
  ] as const)("refuses a backup when encryption is %s, recording why first", async (_label, lines, age, reason) => {
    settings([...lines]);
    age();
    const result = bash("bash scripts/vps-backup.sh");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no unencrypted backup was made");
    expect(existsSync(path.join(dir, "docker.log"))).toBe(false);
    expect(existsSync(path.join(config, "backups"))).toBe(false);
    expect(status()).toMatchObject({ lastStatus: "failed", reason, encrypted: false });
    // The Operations page reads the same file and names the refusal.
    process.env.SWE_STATUS_DIR = path.join(config, "status");
    try {
      const read = await readVpsBackupStatus();
      expect(read?.reason).toBe(reason);
      expect(backupProblem(read)?.subject).toBe("Backups refused: encryption is not working");
    } finally {
      delete process.env.SWE_STATUS_DIR;
    }
  });

  it("goes ahead when encryption works, or was never asked for", () => {
    for (const lines of [[`BACKUP_AGE_RECIPIENT='${recipient}'`], ["BACKUP_KEEP_DAYS='14'"]]) {
      settings(lines);
      working();
      rmSync(path.join(dir, "docker.log"), { force: true });
      const result = bash("bash scripts/vps-backup.sh");
      // The fake docker fails the dump, after the encryption check passed.
      expect(result.stderr).not.toContain("no unencrypted backup was made");
      expect(existsSync(path.join(dir, "docker.log"))).toBe(true);
      expect(status()).toMatchObject({ lastStatus: "failed", reason: null });
    }
  });

  describe("setup", () => {
    // finish_backups from setup-vps.sh, with the steps that need a terminal or systemd stubbed.
    const finish = (ensureAge: boolean) => bash(`
      . scripts/vps-lib.sh
      eval "$(sed -n '/^finish_backups() {/,/^}/p' scripts/setup-vps.sh)"
      managed=1
      has_systemd() { return 0; }
      timer_enabled() { return 1; }
      install_certificate_timer() { echo certificates >> "$FAKE/timers.log"; }
      install_backup_timer() { echo backup >> "$FAKE/timers.log"; }
      ensure_age() { ${ensureAge ? "return 0" : "return 1"}; }
      new_backup_key() { conf_set "$(backup_env)" BACKUP_AGE_RECIPIENT '${recipient}'; }
      finish_backups`);
    const timers = () => (existsSync(path.join(dir, "timers.log")) ? readFileSync(path.join(dir, "timers.log"), "utf8") : "");

    it("installs the nightly timer only after age encrypts to the new key", () => {
      settings(["BACKUP_SCHEDULE='nightly'", "BACKUP_ENCRYPTION='requested'"]);
      working();
      const result = finish(true);
      expect(result.status, result.stderr).toBe(0);
      expect(timers()).toBe("certificates\nbackup\n");
      const saved = readFileSync(path.join(config, "backup.env"), "utf8");
      expect(saved).not.toContain("BACKUP_ENCRYPTION");
      expect(existsSync(path.join(config, "status", "backup.json"))).toBe(false);
    });

    it.each([
      ["age cannot be installed", false, working],
      ["age is installed but fails", true, broken],
    ] as const)("withholds the timer and records why when %s", (_label, ensureAge, age) => {
      settings(["BACKUP_SCHEDULE='nightly'", "BACKUP_ENCRYPTION='requested'"]);
      age();
      const result = finish(ensureAge);
      expect(result.status, result.stderr).toBe(0);
      expect(timers()).toBe("certificates\n");
      expect(result.stderr).toContain("nightly backups were not turned on");
      expect(readFileSync(path.join(config, "backup.env"), "utf8")).toContain("BACKUP_ENCRYPTION='requested'");
      expect(status()).toMatchObject({ lastStatus: "failed", reason: "encryption-unavailable", scheduled: false });
    });
  });

  it("clears the request in the settings menu once encryption works or is turned off", () => {
    const menu = readFileSync(path.join(root, "scripts/vps-backup-settings.sh"), "utf8");
    expect(menu.match(/conf_unset "\$settings" BACKUP_ENCRYPTION/g)).toHaveLength(3);
    expect(menu).toContain("backup_encryption_problem");
    expect(spawnSync("bash", ["-n", "scripts/vps-backup-settings.sh", "scripts/vps-backup.sh", "scripts/setup-vps.sh", "scripts/vps-lib.sh"], { cwd: root }).status).toBe(0);
  });
});
