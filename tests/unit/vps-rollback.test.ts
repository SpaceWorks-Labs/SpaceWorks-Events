import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/*
 * Scripted runs of the VPS deploy, update and status scripts with fake id,
 * docker (Compose, psql, the migrator) and curl on PATH. A release runs only
 * against a database whose every recorded migration it contains: the installed
 * deploy entry point refuses an older release without touching the running
 * one, and a failed update whose migrations the previous release lacks stops
 * the writers instead of restarting it. Nothing touches the real system.
 */
const root = path.resolve(import.meta.dirname, "../..");
const migrations = readdirSync(path.join(root, "prisma/migrations")).filter((name) => /^\d{14}_/.test(name)).sort();
const older = migrations.slice(0, -1);
const newest = migrations.at(-1)!;
let dir = "";
let config = "";

const posix = (value: string) => value.replaceAll("\\", "/").replace(/^([A-Za-z]):\//, (_, drive: string) => `/${drive.toLowerCase()}/`);
const write = (file: string, body: string, mode = 0o644) => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), body, { mode });
};
const bin = (name: string, body: string) => write(`bin/${name}`, `#!/bin/bash\n${body}\n`, 0o755);
const bash = (script: string) => spawnSync("bash", ["-c", `PATH="${posix(dir)}/bin:$PATH"; ${script}`], {
  cwd: root, encoding: "utf8", timeout: 120_000,
  env: { ...process.env, FAKE: posix(dir), SWE_DIR: `${posix(dir)}/swe`, SWE_CONFIG_DIR: posix(config), SWE_STAGED: "", SWE_REPOSITORY: "" },
});
const log = () => (existsSync(path.join(dir, "docker.log")) ? readFileSync(path.join(dir, "docker.log"), "utf8") : "");
const lines = (names: string[]) => names.map((name) => `${name}\n`).join("");
/** A release's source as far as compatibility goes: its migration folders. */
const release = (folder: string, names: string[]) => { for (const name of names) mkdirSync(path.join(dir, folder, "prisma/migrations", name), { recursive: true }); };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "swe-rollback-"));
  config = path.join(dir, "config");
  mkdirSync(config);
  writeFileSync(path.join(config, "compose.env"), "SWE_VERSION='1.0.0'\n");
  write("applied.txt", lines(older));
  write("migrate.txt", "");
  write("migrate-status", "0\n");
  bin("id", '[ "$1" = -u ] && echo 0 || exit 1');
  // Compose: psql prints the recorded migrations; the migrator records migrate.txt (even when it then fails); `up` fails.
  bin("docker", [
    'args="$*"',
    'echo "$args" >> "$FAKE/docker.log"',
    'case "$args" in',
    '  *" exec -T postgres psql "*) cat "$FAKE/applied.txt" ;;',
    '  *" exec -T postgres pg_dump "*) echo dump ;;',
    '  *" exec -T postgres pg_restore "*) cat > /dev/null ;;',
    '  *" run -T --rm migrator"*) cat "$FAKE/migrate.txt" >> "$FAKE/applied.txt"; exit "$(cat "$FAKE/migrate-status")" ;;',
    '  *" up -d --wait"*) exit 1 ;;',
    "esac",
  ].join("\n"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("automatic deploy of a requested release", { timeout: 120_000 }, () => {
  const tag = "v1.2.3-main.42.abcdef012345";
  beforeEach(() => {
    write("swe/install.conf", "SWE_REPOSITORY='example/events'\n");
    write("revision", `abcdef012345${"0".repeat(28)}\n`);
    write("release-src/top/scripts/update-vps.sh", 'echo ran >> "$FAKE/updater.log"\n');
    bin("curl", [
      'url="${@: -1}"',
      'case "$url" in',
      '  */commits/*) cat "$FAKE/revision" ;;',
      `  */releases/tags/*) echo '{"prerelease": false, "draft": false}' ;;`,
      `  */compare/*) echo '  "status": "behind",' ;;`,
      '  https://codeload.github.com/*) cat "$FAKE/release.tar.gz" ;;',
      "  *) exit 22 ;;",
      "esac",
    ].join("\n"));
  });
  const pack = () => expect(bash('tar -czf "$FAKE/release.tar.gz" -C "$FAKE/release-src" top').status).toBe(0);

  it("refuses a release that lacks a migration the database has, leaving the running release untouched", () => {
    release("release-src/top", older.slice(0, -1));
    pack();
    const result = bash(`bash scripts/vps-deploy.sh ${tag}`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`it lacks migrations already applied (${older.at(-1)})`);
    expect(result.stderr).toContain("the running release is unchanged");
    expect(existsSync(path.join(dir, "updater.log"))).toBe(false);
    // Only the migrations were read: nothing stopped, started or pulled.
    expect(log().trim().split("\n")).toHaveLength(1);
    expect(log()).toContain("exec -T postgres psql");
    expect(readFileSync(path.join(config, "compose.env"), "utf8")).toBe("SWE_VERSION='1.0.0'\n");
  });

  it("hands a compatible release to its own updater", () => {
    release("release-src/top", older);
    pack();
    const result = bash(`bash scripts/vps-deploy.sh ${tag}`);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(path.join(dir, "updater.log"), "utf8")).toBe("ran\n");
  });
});

describe("a failed update", { timeout: 120_000 }, () => {
  beforeEach(() => {
    write("swe/current/scripts/vps-compose.sh", 'echo "previous $*" >> "$FAKE/docker.log"\n');
  });
  const update = () => bash("bash scripts/update-vps.sh --yes");

  it("stops the writers and prints the restore when the previous release lacks a migration it recorded, even one that failed", () => {
    release("swe/current", older);
    write("migrate.txt", `${newest}\n`);
    write("migrate-status", "1\n");
    const result = update();
    expect(result.status).not.toBe(0);
    expect(log()).toMatch(/ stop app worker beat\n/);
    expect(log()).not.toContain("previous up");
    expect(result.stderr).toContain(`it lacks migrations already recorded (${newest})`);
    expect(result.stderr).toMatch(/swe\/current\/scripts\/vps-restore\.sh .*\/backups\/2\d+T\d+Z/);
    expect(readFileSync(path.join(config, "compose.env"), "utf8")).toBe("SWE_VERSION='1.0.0'\n");
  });

  it("returns to a previous release that has every recorded migration", () => {
    release("swe/current", migrations);
    write("migrate.txt", `${newest}\n`);
    const result = update();
    expect(result.status).not.toBe(0);
    expect(log()).toContain("previous up -d --wait");
    expect(log()).not.toMatch(/ stop app worker beat/);
  });

  it("refuses to start when this release lacks a migration the database has, before any backup", () => {
    release("swe/current", migrations);
    write("applied.txt", lines([...older, "20991231000000_from_a_newer_release"]));
    const result = update();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("20991231000000_from_a_newer_release");
    expect(result.stderr).toContain("Nothing was changed");
    expect(log()).not.toContain("pg_dump");
    expect(existsSync(path.join(config, "backups"))).toBe(false);
  });
});

describe("status check", { timeout: 120_000 }, () => {
  it("reports no backups yet when the backups folder does not exist, and still runs the checks", () => {
    const result = bash("bash scripts/vps-status.sh");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Newest backup: none yet");
    expect(log()).toMatch(/ ps\n/);
    expect(log()).toContain("check.mjs");
  });

  it("shows any other error listing backups, and still runs the checks", () => {
    mkdirSync(path.join(config, "backups"));
    bin("find", 'echo "find: cannot read the folder" >&2; exit 1');
    const result = bash("bash scripts/vps-status.sh");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("Could not list");
    expect(log()).toContain("check.mjs");
  });
});
