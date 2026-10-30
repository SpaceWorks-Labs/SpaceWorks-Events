import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type Lock = { packages: Record<string, { version?: string; dependencies?: Record<string, string> }> };

const json = <T>(file: string): T => JSON.parse(readFileSync(resolve(__dirname, "../..", file), "utf8")) as T;
const rootLock = json<Lock>("package-lock.json");

describe.each(["docker/deps/prisma-cli", "docker/deps/ops"])("image dependency set %s", (dir) => {
  const manifest = json<{ dependencies: Record<string, string> }>(`${dir}/package.json`);
  const lock = json<Lock>(`${dir}/package-lock.json`);

  it("pins each direct dependency to the root lockfile's version", () => {
    for (const [name, version] of Object.entries(manifest.dependencies)) {
      expect(version, name).toBe(rootLock.packages[`node_modules/${name}`]?.version);
    }
  });

  it("has a lockfile that matches its manifest, so npm ci installs it", () => {
    expect(lock.packages[""]?.dependencies).toEqual(manifest.dependencies);
    for (const [name, version] of Object.entries(manifest.dependencies)) {
      expect(lock.packages[`node_modules/${name}`]?.version, name).toBe(version);
    }
  });
});

describe("Dockerfile", () => {
  const dockerfile = readFileSync(resolve(__dirname, "../..", "Dockerfile"), "utf8");

  it("installs the image-only dependency sets from their lockfiles, never with npm install", () => {
    expect(dockerfile).not.toMatch(/npm install /);
    expect(dockerfile).toContain("COPY docker/deps/prisma-cli/package.json docker/deps/prisma-cli/package-lock.json ./");
    expect(dockerfile).toContain("COPY docker/deps/ops/package.json docker/deps/ops/package-lock.json ./");
  });
});
