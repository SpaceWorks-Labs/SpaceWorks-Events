// Build a rendering-only workspace from the shared UI and fixed API contracts.
import ts from "typescript";
import { Prisma } from "@prisma/client";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "frontend");
const catalog = JSON.parse(readFileSync(path.join(target, "catalog.json"), "utf8"));
for (const directory of ["app", "components", "lib", "public"]) {
  const destination = path.join(target, directory);
  rmSync(destination, { recursive: true, force: true });
  cpSync(path.join(root, directory), destination, { recursive: true,
    filter: (file) => directory !== "app" || !path.relative(path.join(root, "app"), file).startsWith(`api${path.sep}`) && file !== path.join(root, "app", "api"),
  });
}
mkdirSync(path.join(target, "app/api/[...path]"), { recursive: true });
cpSync(path.join(target, "api-route.ts"), path.join(target, "app/api/[...path]/route.ts"));
cpSync(path.join(root, "postcss.config.mjs"), path.join(target, "postcss.config.mjs"));
// The in-app guide renders from MDX and generated indexes; nothing is read at runtime.
rmSync(path.join(target, "content"), { recursive: true, force: true });
cpSync(path.join(root, "content", "help"), path.join(target, "content", "help"), { recursive: true });
cpSync(path.join(root, "mdx-components.tsx"), path.join(target, "mdx-components.tsx"));
// lib/slug.ts reads the reserved organisation slugs from here.
mkdirSync(path.join(target, "scripts"), { recursive: true });
cpSync(path.join(root, "scripts", "reserved-slugs.mjs"), path.join(target, "scripts", "reserved-slugs.mjs"));
// Backend handlers and the registry are never part of the frontend project.
for (const file of ["frontend/handler.ts", "frontend/registry.ts"]) rmSync(path.join(target, "lib", file), { force: true });

for (const [kind, entries] of [["view", catalog.readers], ["action", catalog.actions]]) {
  const groups = Map.groupBy(entries, (entry) => entry.module);
  for (const [module, endpoints] of groups) {
    const output = path.join(target, `${module}.ts`);
    const original = path.relative(path.dirname(output), path.join(root, module)).split(path.sep).join("/");
    const source = `${kind === "action" ? '"use server";\n' : 'import "server-only";\n'}import type * as Backend from ${JSON.stringify(original)};\nexport type * from ${JSON.stringify(original)};\nimport { invokeBackend } from "@/lib/frontend/client";\n` + endpoints.map((item) => `export async function ${item.name}(...args: Parameters<typeof Backend.${item.name}>): Promise<Awaited<ReturnType<typeof Backend.${item.name}>>> {\n  return invokeBackend(${JSON.stringify(kind)}, ${JSON.stringify(item.id)}, args);\n}\n`).join("\n");
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, source);
  }
}
const permissionsSource = ts.createSourceFile("permissions.ts", readFileSync(path.join(root, "lib/permissions.ts"), "utf8"), ts.ScriptTarget.Latest, true);
const guards = permissionsSource.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name && node.modifiers?.some((item) => item.kind === ts.SyntaxKind.ExportKeyword) && node.modifiers.some((item) => item.kind === ts.SyntaxKind.AsyncKeyword));
writeFileSync(path.join(target, "lib/permissions.ts"), `import "server-only";\nimport type * as Backend from "../../lib/permissions";\nexport type * from "../../lib/permissions";\nexport * from "./permissionRoles";\nimport { invokeBackend } from "@/lib/frontend/client";\n` + guards.map((node) => node.name.text === "requireSuperAdminMfa"
  ? `export const requireSuperAdminMfa: typeof Backend.requireSuperAdminMfa = async (...args) => invokeBackend("view", "frontend-gates:loadSuperAdminGate", args);`
  : `export const ${node.name.text}: typeof Backend.${node.name.text} = async () => { throw new Error("Backend-only operation reached the frontend."); };`).join("\n") + "\n");
writeFileSync(path.join(target, "lib/db.ts"), `import type { PrismaClient } from "@prisma/client";\nthrow new Error("Database access cannot run in the frontend workspace. Move it into a guarded view reader.");\nexport const prisma = {} as PrismaClient;\n`);
const enums = Prisma.dmmf.datamodel.enums.map((item) => `export const ${item.name} = ${JSON.stringify(Object.fromEntries(item.values.map((value) => [value.name, value.name])))} as const;\nexport type ${item.name} = (typeof ${item.name})[keyof typeof ${item.name}];`).join("\n");
writeFileSync(path.join(target, "lib/prismaEnums.ts"), enums + '\nexport const Prisma = new Proxy({}, { get() { throw new Error("Backend-only Prisma API reached the frontend."); } });\n');
console.log("Frontend workspace prepared; database, auth persistence, storage and workers remain on the backend.");

// Next.js automatically externalizes Prisma before resolving aliases. Rewrite
// only enum value imports; model/namespace imports remain erased TypeScript.
const enumNames = new Set(Prisma.dmmf.datamodel.enums.map((item) => item.name));
const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(path.join(directory, entry.name)) : /\.tsx?$/.test(entry.name) ? [path.join(directory, entry.name)] : []);
for (const file of ["app", "components", "lib"].flatMap((directory) => walk(path.join(target, directory)))) {
  let source = readFileSync(file, "utf8");
  const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const edits = [];
  for (const node of syntax.statements) {
    if (!ts.isImportDeclaration(node) || node.moduleSpecifier.text !== "@prisma/client" || node.importClause?.isTypeOnly) continue;
    const bindings = node.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const values = bindings.elements.filter((item) => !item.isTypeOnly && enumNames.has((item.propertyName ?? item.name).text));
    if (!values.length) continue;
    const remaining = bindings.elements.filter((item) => !values.includes(item));
    const replacement = `import { ${values.map((item) => item.getText(syntax)).join(", ")} } from "@/lib/prismaEnums";` + (remaining.length ? `\nimport { ${remaining.map((item) => item.getText(syntax)).join(", ")} } from "@prisma/client";` : "");
    edits.push({ start: node.getStart(syntax), end: node.end, replacement });
  }
  for (const edit of edits.reverse()) source = source.slice(0, edit.start) + edit.replacement + source.slice(edit.end);
  if (edits.length) writeFileSync(file, source);
}

// Generated source trees are Git-ignored. Explicit Tailwind sources keep their
// utility classes in the frontend CSS instead of relying on auto discovery.
const cssPath = path.join(target, "app/globals.css");
writeFileSync(cssPath, readFileSync(cssPath, "utf8").replace('@import "tailwindcss";', '@import "tailwindcss";\n@source "../app";\n@source "../components";\n@source "../lib";'));
