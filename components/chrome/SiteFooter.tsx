"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuthSession } from "@/components/auth/useAuthSession";
import { SpaceWorksEventsLogo, SpaceWorksLogo } from "@/components/brand/SpaceWorksLogo";
import { GITHUB_URL, LICENSE_URL } from "@/lib/openSource";

const publicLinks = [
  { label: "Discover", href: "/discover" },
  { label: "Features", href: "/features" },
  { label: "Self-host", href: "/#self-host" },
  { label: "About", href: "/about" },
  { label: "Help", href: "/help" },
  { label: "Privacy", href: "/privacy" },
  { label: "Terms", href: "/terms" },
];

const linkClasses = "text-body-ui text-ink-secondary underline-offset-4 transition-colors hover:text-ink hover:underline";
const creditLinkClasses = "underline underline-offset-4 hover:text-ink";

/** "Powered by Space Works" plus the AGPL source link (the licence asks every install to offer its source). */
function SourceCredit() {
  return (
    <>
      <span>Powered by Space Works</span>
      <span aria-hidden>·</span>
      <span>
        Open source under{" "}
        <a href={LICENSE_URL} target="_blank" rel="noopener noreferrer" className={creditLinkClasses}>AGPL-3.0</a>
      </span>
      <span aria-hidden>·</span>
      <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className={creditLinkClasses}>Source code</a>
    </>
  );
}

/** Space Works Events site footer (Figma 121:1333). */
export function SiteFooter() {
  const pathname = usePathname();
  const { status } = useAuthSession();
  const links = status === "authenticated" ? [{ label: "Dashboard", href: "/dashboard" }, { label: "Account", href: "/account" }, ...publicLinks] : publicLinks;

  return (
    <footer className="mt-auto border-t border-line bg-canvas">
      <div className="mx-auto flex max-w-[1160px] flex-col gap-5 px-4 py-10 sm:px-6 xl:px-0">
        <div className="flex flex-col gap-6 md:flex-row md:items-start md:justify-between">
          <div className="flex flex-col gap-2.5">
            <Link href="/" className="inline-flex items-center self-start" aria-label="Space Works Events home">
              <SpaceWorksEventsLogo height={32} label={null} />
            </Link>
            <p className="text-body-ui text-ink-secondary">Events for people who make things.</p>
          </div>
          <nav aria-label="Footer">
            <ul className="flex flex-wrap gap-x-6 gap-y-2">
              {links.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} aria-current={pathname === link.href ? "page" : undefined} className={linkClasses}>
                    {link.label}
                  </Link>
                </li>
              ))}
              <li>
                <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className={linkClasses}>GitHub</a>
              </li>
            </ul>
          </nav>
        </div>
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 border-t border-line pt-5 text-caption text-ink-muted">
          <SourceCredit />
        </p>
      </div>
    </footer>
  );
}

/** Compact footer for event-facing pages: the organiser leads, Space Works steps back. */
export function EventFooter() {
  return (
    <footer className="mt-auto border-t border-line bg-canvas">
      <div className="mx-auto flex max-w-[1160px] flex-col gap-3 px-4 py-6 text-sm text-ink-muted sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <Link href="/" className="inline-flex items-center gap-2 self-start hover:text-ink">
          <SpaceWorksLogo variant="app-icon" height={18} label={null} />
          <span>Powered by Space Works</span>
        </Link>
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <Link href="/privacy" className={creditLinkClasses}>Privacy</Link>
          <span aria-hidden>·</span>
          <Link href="/terms" className={creditLinkClasses}>Terms</Link>
          <span aria-hidden>·</span>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className={creditLinkClasses}>Source code</a>
        </p>
      </div>
    </footer>
  );
}

/** Credit under an embedded event (inside the organiser's iframe): opens Space Works Events in a new tab. */
export function EmbedCredit() {
  return (
    <footer className="flex justify-center px-4 py-5">
      <a href="/" target="_blank" rel="noopener" className="inline-flex items-center gap-2 text-sm text-ink-muted hover:text-ink">
        <SpaceWorksLogo variant="app-icon" height={18} label={null} />
        <span>Powered by Space Works</span>
      </a>
    </footer>
  );
}
