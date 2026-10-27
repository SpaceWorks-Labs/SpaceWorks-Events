import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// @next/mdx is pinned exactly while next keeps a caret range, so a lockfile
// refresh could move next on its own and leave the guide's MDX loader behind.
const root = process.cwd();
const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8")) as { packages: Record<string, { version?: string }> };
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { dependencies: Record<string, string> };

describe("the guide's MDX loader", () => {
  it("is locked to the same version as next", () => {
    const next = lock.packages["node_modules/next"]?.version;
    expect(next).toBeTruthy();
    expect(lock.packages["node_modules/@next/mdx"]?.version).toBe(next);
  });

  it("is pinned exactly in package.json", () => {
    expect(manifest.dependencies["@next/mdx"]).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
