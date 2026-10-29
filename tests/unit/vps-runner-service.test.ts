import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/*
 * Scripted dry runs of the deploy runner's service helpers (scripts/runner-service.sh)
 * with a fake systemctl and stat on PATH: nothing touches the real system.
 */
const root = path.resolve(import.meta.dirname, "../..");
const repository = "SpaceWorks-Labs/SpaceWorks-Events";
const legacy = "actions.runner.SpaceWorks-Labs-SpaceWorks-Events.host-spaceworks-events.service";
let dir = "";
let units = "";
let runner = "";

// Paths as bash sees them (Git Bash on Windows needs /c/... in PATH).
const posix = (value: string) => value.replaceAll("\\", "/").replace(/^([A-Za-z]):\//, (_, drive: string) => `/${drive.toLowerCase()}/`);

function run(snippet: string, env: Record<string, string> = {}) {
  const fake = posix(dir);
  const script = `. scripts/vps-lib.sh; . scripts/runner-service.sh; SYSTEMD_UNIT_DIR='${posix(units)}'; RUNNER_USER=swe-runner; RUNNER_DIR='${posix(runner)}'; repository=${repository}; ${snippet}`;
  return spawnSync("bash", ["-c", `PATH="${fake}/bin:$PATH"; ${script}`], {
    cwd: root, encoding: "utf8", env: { ...process.env, FAKE: fake, ...env },
  });
}
const log = () => (existsSync(path.join(dir, "systemctl.log")) ? readFileSync(path.join(dir, "systemctl.log"), "utf8") : "");

// What `systemctl show` reports for a unit, as systemd prints it.
function legacyUnit(name: string, overrides: Partial<Record<"FragmentPath" | "User" | "WorkingDirectory" | "ExecStart", string>> = {}) {
  const file = path.join(units, name);
  writeFileSync(file, "[Service]\n");
  const program = `${posix(runner)}/runsvc.sh`;
  const show = {
    FragmentPath: posix(file),
    User: "swe-runner",
    WorkingDirectory: posix(runner),
    ExecStart: `{ path=${program} ; argv[]=${program} ; ignore_errors=no ; start_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`,
    ...overrides,
  };
  writeFileSync(path.join(dir, "show", name), Object.entries(show).map(([key, value]) => `${key}=${value}\n`).join(""));
  return file;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "swe-runner-service-"));
  units = path.join(dir, "units");
  runner = path.join(dir, "runner");
  for (const sub of ["bin", "show", "units", "runner"]) mkdirSync(path.join(dir, sub));
  writeFileSync(path.join(dir, "bin", "systemctl"), [
    "#!/bin/bash",
    'printf "%s\\n" "$*" >> "$FAKE/systemctl.log"',
    'if [ "$1" = show ]; then cat "$FAKE/show/${!#}" 2>/dev/null; fi',
    "exit 0",
  ].join("\n"), { mode: 0o755 });
  writeFileSync(path.join(dir, "bin", "stat"), '#!/bin/bash\necho "${FAKE_UID:-0}"\n', { mode: 0o755 });
  writeFileSync(path.join(runner, ".service"), `${legacy}\n`);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("deploy runner service", { timeout: 120_000 }, () => {
  it("writes its own unit, run as swe-runner from the runner's directory", () => {
    const result = run("write_runner_unit");
    expect(result.status, result.stderr).toBe(0);
    const unit = readFileSync(path.join(units, "swevents-runner.service"), "utf8");
    expect(unit).toContain("User=swe-runner\n");
    expect(unit).toContain(`WorkingDirectory=${posix(runner)}\n`);
    expect(unit).toContain(`ExecStart=/bin/bash ${posix(runner)}/bin/runsvc.sh\n`);
    expect(log()).toContain("enable swevents-runner.service");
    expect(log()).toContain("restart swevents-runner.service");
  });

  it("replaces an earlier svc.sh unit once systemd ties it to this runner", () => {
    const file = legacyUnit(legacy);
    const result = run("stop_runner_services");
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(path.join(runner, ".service"))).toBe(false);
    expect(log()).toContain("disable --now swevents-runner.service");
    expect(log()).toContain(`disable --now -- ${legacy}`);
  });

  it.each([
    ["another user", { User: "root" }],
    ["another working directory", { WorkingDirectory: "/opt/elsewhere" }],
    ["a program outside the runner", { ExecStart: "{ path=/usr/bin/bash ; argv[]=/usr/bin/bash -c id ; }" }],
    ["a program escaping the runner", { ExecStart: "{ path=RUNNER/../../bin/sh ; argv[]=x ; }" }],
    ["a unit file somewhere else", { FragmentPath: "/run/systemd/transient/x.service" }],
  ])("refuses an earlier unit with %s and leaves it in place", (_label, overrides) => {
    const patched = Object.fromEntries(Object.entries(overrides).map(([key, value]) => [key, value.replace("RUNNER", posix(runner))]));
    const file = legacyUnit(legacy, patched);
    const result = run("stop_runner_services");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not match this runner");
    expect(existsSync(file)).toBe(true);
    expect(log()).not.toContain(`disable --now -- ${legacy}`);
  });

  it("refuses an earlier unit file that root does not own", () => {
    const file = legacyUnit(legacy);
    const result = run("stop_runner_services", { FAKE_UID: "1001" });
    expect(result.status).toBe(1);
    expect(existsSync(file)).toBe(true);
  });

  it("refuses a symlinked earlier unit", () => {
    const target = path.join(dir, "elsewhere.service");
    writeFileSync(target, "[Service]\n");
    const link = path.join(units, legacy);
    try {
      symlinkSync(target, link);
    } catch {
      return; // No symlinks on this host (Windows without the privilege).
    }
    if (!lstatSync(link).isSymbolicLink()) return;
    writeFileSync(path.join(dir, "show", legacy), `FragmentPath=${posix(link)}\nUser=swe-runner\nWorkingDirectory=${posix(runner)}\nExecStart={ path=${posix(runner)}/runsvc.sh ; }\n`);
    const result = run("stop_runner_services");
    expect(result.status).toBe(1);
    expect(existsSync(target)).toBe(true);
  });

  it("leaves units of other repositories and unrelated names alone", () => {
    const other = legacyUnit("actions.runner.someone-else.host.service", { User: "root" });
    const odd = legacyUnit("actions.runner.SpaceWorks-Labs-SpaceWorks-Events.$(id).service", { User: "root" });
    const result = run("stop_runner_services");
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(odd)).toBe(true);
    expect(log()).not.toContain("disable --now -- actions.runner");
  });

  it("never runs or sources anything from the runner's directory as root", () => {
    const installer = readFileSync(path.join(root, "scripts/install-runner.sh"), "utf8");
    const helpers = readFileSync(path.join(root, "scripts/runner-service.sh"), "utf8");
    for (const source of [installer, helpers]) {
      expect(source).not.toContain("./svc.sh");
      expect(source).not.toMatch(/svc\.sh (install|uninstall|start|stop)\b/);
      expect(source).not.toMatch(/bash "\$RUNNER_DIR/);
      expect(source).not.toContain("chown -R");
    }
    expect(installer).toContain('bash "$temporary/archive/bin/installdependencies.sh"');
    expect(installer).toContain('runuser -u "$RUNNER_USER" -- tar -xzf - -C "$RUNNER_DIR" < "$temporary/runner.tar.gz"');
    expect(installer).toContain("/usr/local/sbin/swevents-deploy");
    expect(spawnSync("bash", ["-n", "scripts/install-runner.sh", "scripts/runner-service.sh"], { cwd: root }).status).toBe(0);
  });
});
