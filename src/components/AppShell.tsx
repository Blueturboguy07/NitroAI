import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import {
  ChevronsLeft,
  ChevronsRight,
  Home,
  Palette,
  PenLine,
  Settings as SettingsIcon,
} from "lucide-react";
import { toggleTheme } from "../lib/theme";

const navItems = [
  { to: "/", label: "Dashboard", icon: Home },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];

export default function AppShell() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="flex h-full bg-bg">
      <aside
        className={`flex shrink-0 flex-col border-r border-edge bg-panel transition-all ${
          collapsed ? "w-16" : "w-64"
        }`}
      >
        <div className="flex items-center justify-between px-4 py-5">
          {!collapsed && (
            <div className="flex items-center gap-2">
              <PenLine className="size-5 text-accent" />
              <span className="font-display text-lg font-semibold tracking-tight">
                nitro ai
              </span>
            </div>
          )}
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="rounded-lg p-1.5 text-ink-dim hover:bg-card-hover hover:text-ink"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <ChevronsRight className="size-4" /> : <ChevronsLeft className="size-4" />}
          </button>
        </div>

        <nav className="flex flex-col gap-1 px-3">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold ${
                  isActive
                    ? "bg-card-hover text-ink"
                    : "text-ink-dim hover:bg-card-hover hover:text-ink"
                }`
              }
            >
              <Icon className="size-4.5 shrink-0" />
              {!collapsed && label}
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto flex flex-col gap-1 px-3 pb-4">
          <button
            onClick={() => toggleTheme()}
            className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold text-ink-dim hover:bg-card-hover hover:text-ink"
          >
            <Palette className="size-4.5 shrink-0" />
            {!collapsed && "Theme"}
          </button>
          <div className="flex items-center gap-3 rounded-xl px-3 py-2.5">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft font-display text-xs font-bold text-accent">
              N
            </div>
            {!collapsed && <span className="truncate text-sm font-semibold">You</span>}
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
