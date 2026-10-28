import Module from "node:module";
import path from "node:path";

/*
 * The app's encryption helpers start with `import "server-only"`, which
 * Next.js resolves internally and plain Node cannot. Point it at the same
 * empty module the unit tests use, before any lib/ module is loaded. Import
 * this file first.
 */
const EMPTY = path.resolve(__dirname, "../../helpers/server-only.ts");
type Resolver = (request: string, ...rest: unknown[]) => string;
const loader = Module as unknown as { _resolveFilename: Resolver };
const original = loader._resolveFilename;
loader._resolveFilename = function resolve(this: unknown, request: string, ...rest: unknown[]) {
  return request === "server-only" ? EMPTY : original.call(this, request, ...rest);
};
