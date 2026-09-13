import { useState } from "react";
import { AlertTriangle, Bot, History, LayoutGrid, Mail, LogOut, Menu } from "lucide-react";
import { IoChatbubblesOutline } from "react-icons/io5";
import { cn } from "@/lib/utils";
import { Sheet } from "@/components/ui/Sheet";
import type { View } from "@/App";

/**
 * Mobile bottom tab bar (< lg). Primary destinations get their own tab; the
 * rest (Past runs, Export report, Feedback & support, About) live behind a
 * "More" tab that opens a bottom sheet, so every desktop feature stays
 * reachable on a phone. Fixed to the viewport bottom, safe-area aware,
 * touch targets >= 44px.
 */

interface MobileNavProps {
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

const MORE_VIEWS: View[] = ["history", "email", "feedback"];

export default function MobileNav({
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
}: MobileNavProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreActive = MORE_VIEWS.includes(view);

  return (
    <>
      <nav
        className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-black/95 backdrop-blur lg:hidden"
        aria-label="Primary"
      >
        <div className="flex items-stretch">
          <TabButton
            icon={<LayoutGrid className="h-5 w-5" />}
            label="Overview"
            active={view === "overview"}
            onClick={() => onSelectView("overview")}
          />
          <TabButton
            icon={<AlertTriangle className="h-5 w-5" />}
            label="Issues"
            count={issuesCount > 0 ? issuesCount : undefined}
            active={view === "issues"}
            onClick={() => onSelectView("issues")}
          />
          {agentCount > 0 && (
            <TabButton
              icon={<Bot className="h-5 w-5" />}
              label="Agents"
              count={agentCount}
              active={view === "agents"}
              onClick={() => onSelectView("agents")}
            />
          )}
          <TabButton
            icon={<Menu className="h-5 w-5" />}
            label="More"
            active={moreActive}
            onClick={() => setMoreOpen(true)}
          />
        </div>
      </nav>

      <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} title="More" label="More options">
        <div className="p-2 pb-4">
          <MoreItem
            icon={<History className="h-4 w-4" />}
            label="Past runs"
            count={runCount > 0 ? runCount : undefined}
            onClick={() => {
              setMoreOpen(false);
              onOpenHistory();
            }}
          />
          {finished && (
            <MoreItem
              icon={<Mail className="h-4 w-4" />}
              label="Export report"
              onClick={() => {
                setMoreOpen(false);
                onOpenEmail();
              }}
            />
          )}
          <MoreItem
            icon={<IoChatbubblesOutline className="h-4 w-4" />}
            label="Feedback & support"
            onClick={() => {
              setMoreOpen(false);
              onSelectView("feedback");
            }}
          />

          <div className="my-2 h-px bg-white/10" />

          {verified && email ? (
            <div className="flex items-center gap-2.5 rounded-lg px-3 py-2.5">
              <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-emerald-400 to-cyan-500 text-[11px] font-semibold text-white">
                {email[0]?.toUpperCase() || "U"}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-white/70">{email}</span>
              <button
                onClick={() => {
                  setMoreOpen(false);
                  onForget();
                }}
                aria-label="Forget this email"
                className="flex flex-shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 py-1.5 text-xs text-white/40 transition-colors hover:text-red-400"
              >
                <LogOut className="h-3.5 w-3.5" />
                Forget
              </button>
            </div>
          ) : (
            <p className="px-3 py-2 text-xs text-white/35">Local viewer</p>
          )}
          <a
            href="https://strix.ai"
            target="_blank"
            rel="noopener noreferrer"
            className="block px-3 py-2 text-xs text-white/25 transition-colors hover:text-white/50"
          >
            Strix Cloud &rarr;
          </a>
        </div>
      </Sheet>
    </>
  );
}

function TabButton({
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
        "relative flex min-h-[56px] flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 py-1.5 transition-colors",
        active ? "text-white" : "text-white/45"
      )}
    >
      <span className="relative">
        {icon}
        {count != null && (
          <span className="absolute -right-2 -top-1.5 rounded-full bg-white px-1 text-[9px] font-semibold leading-[14px] text-black">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </span>
      <span className="text-[10px] font-medium">{label}</span>
    </button>
  );
}

function MoreItem({
  icon,
  label,
  count,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex min-h-[44px] w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left text-white/85 transition-colors hover:bg-white/5"
    >
      <span className="flex-shrink-0 text-white/50">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
      {count != null && (
        <span className="flex-shrink-0 rounded-full px-1.5 py-0.5 text-[10px] tabular-nums text-white/45">
          {count}
        </span>
      )}
    </button>
  );
}
