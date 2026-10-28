import type { HelpSectionEntry } from "../manifest";

export const account = {
  id: "account",
  title: "Your account",
  description: "Signing in, keeping your account secure, and looking after your own data.",
  access: "public",
  articles: [
    { slug: "account/sign-up-and-sign-in", title: "Creating an account and signing in", summary: "Sign up with email or Google, verify your address, and sign in from a new device." },
    { slug: "account/forgotten-password", title: "Forgotten your password?", summary: "Reset your password with an emailed link." },
    { slug: "account/two-step-verification", title: "Two-step verification", summary: "Set up an authenticator app, which organisation staff must use, and keep your recovery codes safe." },
    { slug: "account/profile-and-security", title: "Profile, appearance and security", summary: "Change your name, photo and theme, see recent security activity, and sign out everywhere." },
    { slug: "account/your-data", title: "Your data and memberships", summary: "Your registrations, download your personal data, and leave organisations you no longer help run." },
  ],
} as const satisfies HelpSectionEntry;
