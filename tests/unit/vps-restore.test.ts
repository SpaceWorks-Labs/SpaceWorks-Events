import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const posix = (value: string) => value.replaceAll("\\", "/").replace(/^([A-Za-z]):\//, (_, drive: string) => `/${drive.toLowerCase()}/`);
let dir = "";
const write = (file: string, body: string, mode = 0o644) => {
  const target = path.join(dir, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body, { mode });
};
const run = (answer: string, args = "") => spawnSync("bash", ["-c", `PATH="${posix(dir)}/bin:$PATH"; bash "$FAKE/release/scripts/vps-restore.sh" "$FAKE/backup" ${args}`], {
  cwd: root, encoding: "utf8", timeout: 120_000,
  env: { ...process.env, FAKE: posix(dir), SWE_DIR: `${posix(dir)}/swe`, SWE_CONFIG_DIR: `${posix(dir)}/config`, ANSWER: answer, SWE_LOCK_HELD: "" },
});
const log = () => existsSync(path.join(dir, "steps.log")) ? readFileSync(path.join(dir, "steps.log"), "utf8") : "";
const expectSqlRemoved = () => {
  const result = spawnSync("bash", ["-c", 'test ! -e "$SQL_PATH"'], {
    encoding: "utf8", timeout: 10_000,
    env: { ...process.env, SQL_PATH: readFileSync(path.join(dir, "sql-path"), "utf8").trim() },
  });
  expect(result.status, result.stderr).toBe(0);
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "swe-restore-"));
  write("config/compose.env", "SWE_STORAGE='external'\nSWE_CADDY_TLS='proxy'\n");
  write("backup/database.dump", "SELECT 'restored data';\n");
  write("bin/id", '#!/bin/bash\necho 0\n', 0o755);
  // Avoid Git Bash opening existing ancestors for writing in a Windows sandbox.
  if (process.platform === "win32") write("bin/mkdir", [
    '#!/bin/bash',
    'if [[ ${1:-} = -p ]]; then',
    '  shift; node -e \'for (const p of process.argv.slice(1)) require("node:fs").mkdirSync(p, { recursive: true });\' "$@"',
    'else /usr/bin/mkdir "$@"; fi',
  ].join("\n"), 0o755);
  write("release/scripts/vps-restore.sh", readFileSync(path.join(root, "scripts/vps-restore.sh"), "utf8").replaceAll("/dev/tty", "/dev/null"));
  // Stub terminal input and backup; keep the real restore and Compose wrapper.
  write("release/scripts/vps-lib.sh", `${readFileSync(path.join(root, "scripts/vps-lib.sh"), "utf8")}\n
require_tty() { :; }
ask() { echo confirmation >> "$FAKE/steps.log"; printf -v "$1" '%s' "$ANSWER"; }
`);
  write("release/scripts/vps-compose.sh", [
    'if [ "$1" = exec ]; then',
    '  echo "$1 $2 $3" >> "$FAKE/steps.log"',
    '  shift 3; "$@"',
    'else echo "$*" >> "$FAKE/steps.log"; fi',
  ].join("\n"));
  write("release/scripts/vps-backup.sh", 'echo safety-backup >> "$FAKE/steps.log"\n');
  // Execute the real container shell and capture SQL with stub database clients.
  write("bin/mktemp", [
    '#!/bin/bash',
    'temp=$(/usr/bin/mktemp)',
    'echo "$temp" > "$FAKE/sql-path"',
    'echo "$temp"',
  ].join("\n"), 0o755);
  write("bin/pg_restore", [
    '#!/bin/bash',
    'echo "pg_restore $*" >> "$FAKE/steps.log"',
    'cat',
    '[[ ! -f "$FAKE/fail-conversion" ]] || exit 47',
  ].join("\n"), 0o755);
  write("bin/psql", [
    '#!/bin/bash',
    'echo psql >> "$FAKE/steps.log"',
    'printf "%s\\n" "$@" > "$FAKE/psql-args"',
    'while (($#)); do',
    '  case "$1" in',
    '    -c) printf "%s\\n" "$2" >> "$FAKE/restore.sql"; shift ;;',
    '    -f) echo "$2" > "$FAKE/sql-path"; cat "$2" >> "$FAKE/restore.sql"; shift ;;',
    '  esac',
    '  shift',
    'done',
    '[[ ! -f "$FAKE/fail-restore" ]] || exit 3',
  ].join("\n"), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("VPS restore application schema", { timeout: 120_000 }, () => {
  it("resets and restores through one psql transaction after confirmation, safety backup and writer shutdown", () => {
    const result = run("RESTORE");
    expect(result.status, result.stderr).toBe(0);
    const steps = log().trim().split("\n");
    expect(steps.slice(0, 3)).toEqual(["confirmation", "safety-backup", "stop app worker beat"]);
    expect(steps.slice(3, 6)).toEqual(["exec -T postgres", "pg_restore --clean --if-exists -f -", "psql"]);
    expect(steps.filter((step) => step === "psql")).toHaveLength(1);
    expect(steps[6]).toContain("up -d --wait");
    const args = readFileSync(path.join(dir, "psql-args"), "utf8");
    expect(args).toContain("-U\nswevents\n-d\nswevents\n-X\n-v\nON_ERROR_STOP=1\n--single-transaction\n-c\n");
    expect(args).toContain("\n-f\n");
    const sql = readFileSync(path.join(dir, "restore.sql"), "utf8");
    expect(sql).toContain("DROP SCHEMA public CASCADE;\n        CREATE SCHEMA public AUTHORIZATION pg_database_owner;");
    expect(sql).toContain("GRANT USAGE ON SCHEMA public TO PUBLIC;");
    const init = readFileSync(path.join(root, "docker/vps/init-database.sh"), "utf8");
    for (const grant of init.split(/\r?\n/).filter((line) => line.startsWith("GRANT USAGE ON SCHEMA") || line.startsWith("ALTER DEFAULT PRIVILEGES"))) {
      expect(sql).toContain(grant);
      expect(sql.indexOf(grant)).toBeLessThan(sql.indexOf("SELECT 'restored data'"));
    }
    expect(sql).toContain("SELECT 'restored data';");
    expectSqlRemoved();
  });

  it("exits non-zero on a restore SQL error and uses the existing service recovery", () => {
    write("fail-restore", "");
    const result = run("RESTORE");
    expect(result.status, result.stderr).toBe(3);
    expect(log()).toContain("psql\nup -d\n");
    expect(log()).not.toContain("--wait");
    expect(log()).not.toContain("check.mjs");
    expect(result.stderr).toContain("The restore failed; starting the services again.");
    expect(result.stdout).not.toContain("Restore finished");
    expectSqlRemoved();
  });

  it("never runs the reset when dump conversion fails after producing partial SQL", () => {
    write("fail-conversion", "");
    const result = run("RESTORE");
    expect(result.status, result.stderr).toBe(47);
    expect(log()).toContain("pg_restore --clean --if-exists -f -\nup -d\n");
    expect(log()).not.toContain("psql");
    expect(log()).not.toContain("--wait");
    expect(existsSync(path.join(dir, "restore.sql"))).toBe(false);
    expectSqlRemoved();
  });

  it("leaves the database and services alone when confirmation is declined", () => {
    const result = run("CANCEL");
    expect(result.status).toBe(2);
    expect(log()).toBe("confirmation\n");
    expect(result.stdout).toContain("Cancelled. Nothing was changed.");
  });

  it("accepts the existing --yes confirmation for automation", () => {
    const result = run("CANCEL", "--yes");
    expect(result.status, result.stderr).toBe(0);
    expect(log()).not.toContain("confirmation");
    expect(log().indexOf("safety-backup")).toBeLessThan(log().indexOf("psql"));
  });
});
