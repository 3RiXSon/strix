import { AlertTriangle, Bot, History, LayoutGrid, Mail, LogOut } from "lucide-react";
import { IoChatbubblesOutline } from "react-icons/io5";
import { cn } from "@/lib/utils";
import type { View } from "@/App";

/**
 * Desktop left nav rail (>= lg). A fixed-width black rail: brand header, a
 * flat list of nav rows, and a user footer. No drag-to-resize, no collapse —
 * that was desktop power-user cruft the rewrite drops in favor of a simple,
 * always-visible rail.
 */

const WIDTH = 248;

interface DesktopNavProps {
  view: View;
  onSelectView: (view: View) => void;
  issuesCount: number;
  agentCount: number;
  runCount: number;
  finished: boolean;
  verified: boolean;
  email: string | null;
  onOpenEmail: () => void;
  onOpenHistory: () => void;
  onForget: () => void;
}

export default function DesktopNav({
  view,
  onSelectView,
  issuesCount,
  agentCount,
  runCount,
  finished,
  verified,
  email,
  onOpenEmail,
  onOpenHistory,
  onForget,
}: DesktopNavProps) {
  return (
    <aside
      className="sticky top-0 hidden h-screen flex-shrink-0 flex-col border-r border-white/10 bg-black lg:flex"
      style={{ width: WIDTH }}
    >
      {/* Brand */}
      <div className="flex h-14 flex-shrink-0 items-center gap-2 px-4">
        <img src="./logo.png" alt="" className="h-6 w-8 object-cover" />
        <span className="text-sm font-medium tracking-tight text-white">Strix</span>
        <span className="ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium text-white/50 bg-white/10">
          Local
        </span>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto scrollbar-thin px-2 py-1">
        <div className="flex flex-col gap-0.5">
          <NavItem
            icon={<LayoutGrid className="h-4 w-4" />}
            label="Overview"
            active={view === "overview"}
            onClick={() => onSelectView("overview")}
          />
          <NavItem
            icon={<AlertTriangle className="h-4 w-4" />}
            label="Issues"
            count={issuesCount > 0 ? issuesCount : undefined}
            active={view === "issues"}
            onClick={() => onSelectView("issues")}
          />
          {agentCount > 0 && (
            <NavItem
              icon={<Bot className="h-4 w-4" />}
              label="Agents"
              count={agentCount}
              active={view === "agents"}
              onClick={() => onSelectView("agents")}
            />
          )}

          <div className="my-2 h-px bg-white/10" />

          <NavItem
            icon={<History className="h-4 w-4" />}
            label="Past runs"
            count={runCount > 0 ? runCount : undefined}
            active={view === "history"}
            onClick={onOpenHistory}
          />
          {finished && (
            <NavItem
              icon={<Mail className="h-4 w-4" />}
              label="Export report"
              active={view === "email"}
              onClick={onOpenEmail}
            />
          )}
          <NavItem
            icon={<IoChatbubblesOutline className="h-4 w-4" />}
            label="Feedback & support"
            active={view === "feedback"}
            onClick={() => onSelectView("feedback")}
          />
        </div>
      </nav>

      {/* Footer */}
      <div className="flex-shrink-0 border-t border-white/10 p-3">
        {verified && email ? (
          <div className="group flex items-center gap-2 rounded-lg px-2 py-2">
            <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-emerald-400 to-cyan-500 text-[10px] font-semibold text-white">
              {email[0]?.toUpperCase() || "U"}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-white/70">{email}</span>
            <button
              onClick={onForget}
              aria-label="Forget this email"
              title="Forget this email"
              className="flex-shrink-0 cursor-pointer rounded p-1 text-white/30 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <p className="px-2 py-1.5 text-xs text-white/35">Local viewer</p>
        )}
        <a
          href="https://strix.ai"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 block px-2 py-1 text-[11px] text-white/25 transition-colors hover:text-white/50"
        >
          Strix Cloud &rarr;
        </a>
      </div>
    </aside>
  );
}

function NavItem({
  icon,
  label,
  active,
  onClick,
  count,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  count?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left transition-colors",
        active ? "bg-white/10 text-white" : "text-white/55 hover:bg-white/5 hover:text-white/90"
      )}
    >
      <span className="flex-shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{label}</span>
      {count != null && (
        <span className="flex-shrink-0 rounded-full px-1.5 py-0.5 text-[10px] tabular-nums leading-none text-white/45">
          {count}
        </span>
      )}
    </button>
  );
}
