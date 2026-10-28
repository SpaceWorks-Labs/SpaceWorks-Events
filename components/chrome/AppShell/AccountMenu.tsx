"use client";

import { useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { ChevronsUpDown, CircleHelp, LogOut, Moon, Sun, UserRound } from "lucide-react";
import { cn } from "@/lib/cn";
import type { ShellUser } from "@/lib/appShell";
import { useAppColorMode } from "@/components/providers";
import { Avatar } from "@/components/ui/display";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";

/** The person's menu: account, the guide, light/dark mode and sign out. */
export function AccountMenu({ user, collapsed, onNavigate }: { user: ShellUser; collapsed: boolean; onNavigate?: () => void }) {
  const pathname = usePathname() ?? "";
  const { mode, toggleColorMode } = useAppColorMode();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const name = user.name ?? user.email ?? "Account";
  return (
    <Menu>
      <MenuTrigger
        ref={triggerRef}
        aria-label={collapsed ? `Account menu for ${name}` : undefined}
        className={cn(
          "flex min-h-12 w-full items-center gap-2.5 rounded-[10px] border border-line bg-panel text-left transition-colors hover:bg-surface data-[state=open]:bg-surface",
          collapsed ? "justify-center p-1.5" : "p-2",
          pathname.startsWith("/account") && "ring-1 ring-line-strong",
        )}
      >
        <Avatar name={user.name ?? user.email} src={user.image} size="sm" className="size-8 text-[11px]" />
        {collapsed ? null : (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-ink">{name}</span>
              {user.email && user.name ? <span className="block truncate text-caption text-ink-muted">{user.email}</span> : null}
            </span>
            <ChevronsUpDown aria-hidden className="size-4 shrink-0 text-ink-muted" />
          </>
        )}
      </MenuTrigger>
      <MenuContent side={collapsed ? "right" : "top"} align={collapsed ? "end" : "start"} className="min-w-[232px]">
        <MenuLabel>{name}</MenuLabel>
        <MenuItem asChild icon={<UserRound />}>
          <Link href="/account" onClick={onNavigate}>Account settings</Link>
        </MenuItem>
        <MenuItem asChild icon={<CircleHelp />}>
          <Link href="/help" onClick={onNavigate}>Help and guide</Link>
        </MenuItem>
        <MenuItem
          icon={mode === "dark" ? <Sun /> : <Moon />}
          onSelect={() => {
            // Reveal the new mode from the account button, which stays on screen.
            const rect = triggerRef.current?.getBoundingClientRect();
            toggleColorMode(rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : undefined);
          }}
        >
          {mode === "dark" ? "Light mode" : "Dark mode"}
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={<LogOut />} onSelect={() => void signOut({ callbackUrl: "/" })}>
          Sign out
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
