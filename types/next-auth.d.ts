import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
    } & DefaultSession["user"];
    /** How this web session signed in; absent for app sessions and old tokens. */
    authMethod?: "credentials" | "google";
  }
}
