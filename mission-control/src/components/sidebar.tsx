"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Bot,
  Users,
  Terminal,
  ScrollText,
  Settings,
  Zap,
} from "lucide-react";

const nav = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/console", label: "Console", icon: Terminal },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/teams", label: "Teams", icon: Users },
  { href: "/logs", label: "Logs & Events", icon: ScrollText },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex h-screen w-60 flex-col border-r bg-card">
      {/* Logo */}
      <div className="flex items-center gap-2.5 border-b px-5 py-4">
        <div className="flex h-8 w-8 items-center justify-center bg-primary text-primary-foreground">
          <Zap className="h-4 w-4" />
        </div>
        <div>
          <h1 className="text-sm font-bold tracking-tight">TinyClaw</h1>
          <p className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
            Mission Control
          </p>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-0.5 p-3">
        {nav.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-3 px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="border-t p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <div className="h-2 w-2 animate-pulse-dot bg-primary" />
          Queue Processor
        </div>
      </div>
    </aside>
  );
}
