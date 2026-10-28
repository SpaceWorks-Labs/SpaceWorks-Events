import path from "node:path";
import type { NextConfig } from "next";
import shared from "../next.config";

const root = path.resolve(__dirname, "..");
const config: NextConfig = {
  ...shared,
  // Netlify packages the build itself; the frontend container needs standalone output.
  output: process.env.SWE_FRONTEND_STANDALONE === "1" ? "standalone" : undefined,
  serverExternalPackages: ["sharp"],
  // Keep the shared Turbopack rules (the guide's MDX loader) and move the root.
  turbopack: { ...shared.turbopack, root },
};
export default config;
