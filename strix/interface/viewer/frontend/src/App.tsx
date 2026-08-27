import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, AlertCircle, Bot, ChevronDown, History, Mail } from "lucide-react";
import type { Vulnerability, VulnerabilitySeverity } from "@/types/issues";
import { SEVERITY_COLORS } from "@/types/issues";
import { getSeverityDot } from "@/lib/vulnerability-utils";
import VulnerabilityDetail from "@/components/vulnerability/VulnerabilityDetail";
import { ContentSection } from "@/components/vulnerability/ContentSection";
import { IssueSeveritySummary } from "@/components/IssueSeveritySummary";
import AgentGraph from "@/components/live/AgentGraph";
import { buildGraphAgents } from "@/components/live/AgentTranscript";
import AgentDetailModal from "@/components/live/AgentDetailModal";
import { ScanPromptComposer } from "@/components/live/ScanPromptComposer";
import { severityCounts, type ParsedRunSummary } from "@/lib/local-run-parser";
import {
  fetchAll,
  fetchAuthStatus,
  fetchCapabilities,
  fetchRunSummary,
  fetchRuns,
  fetchTranscript,
  fetchVulnerabilities,
  forgetAuth,
  type AuthStatus,
  type LoadedRun,
  type RunsPayload,
} from "@/data/serverSource";
import { trackCta } from "@/lib/cta";
import { runTitle } from "@/lib/target-utils";
import { card, cardPad, primaryBtn } from "@/lib/ui";
import DesktopNav from "@/components/nav/DesktopNav";
import MobileNav from "@/components/nav/MobileNav";
import PastRunsView from "@/components/PastRunsView";
import EmailReportView from "@/components/EmailReportView";
import { RunDetails } from "@/components/RunDetails";
import { TrustToast } from "@/components/TrustToast";
import FeedbackView from "@/components/FeedbackView";

export type View = "overview" | "issues" | "agents" | "history" | "email" | "feedback";

const TRUST_BANNER =
  "Your findings stay on your machine. They're rendered here locally in your browser and never uploaded or stored by Strix.";

const SEVERITY_ORDER: VulnerabilitySeverity[] = ["critical", "high", "medium", "low"];
const POLL_MS = 500;

export default function App() {
  const [activeRun, setActiveRun] = useState<string | null>(null);
  const [run, setRun] = useState<LoadedRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<View>("overview");
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [runs, setRuns] = useState<RunsPayload | null>(null);
  const [emailPurpose, setEmailPurpose] = useState<"report" | "verify">("report");
  const [emailSkipDisclosure, setEmailSkipDisclosure] = useState(false);
  // Whether this viewer can steer a live scan (true only inside the in-TUI
  // launcher that shares the running scan's coordinator + event loop).
  const [canSteer, setCanSteer] = useState(false);

  const refreshAuth = useCallback(async () => {
    try {
      setAuth(await fetchAuthStatus());
    } catch {
      /* auth status is best-effort; the launched run stays viewable */
    }
  }, []);

  const refreshRuns = useCallback(async () => {
    try {
      setRuns(await fetchRuns());
    } catch {
      /* history list is best-effort */
    }
  }, []);

  useEffect(() => {
    void refreshAuth();
    void refreshRuns();
    // Capabilities never change over a session, so fetch once on mount.
    fetchCapabilities()
      .then((caps) => setCanSteer(caps.can_steer))
      .catch(() => {
        /* absence of steering is the safe default */
      });
  }, [refreshAuth, refreshRuns]);

  // Live polling, scoped to the active run. Re-runs when the active run changes
  // so switching to a past run (?run=<name>) reloads its data; a finished run
  // does a single full fetch and stops.
  const finishedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    finishedRef.current = false;

    const schedule = () => {
      timer = setTimeout(tick, POLL_MS);
    };

    const tick = async () => {
      if (cancelled) return;
      try {
        const { summary, raw, finished } = await fetchRunSummary(activeRun);
        if (cancelled) return;
        if (finished && !finishedRef.current) {
          finishedRef.current = true;
          const full = await fetchAll(activeRun);
          if (!cancelled) setRun(full);
          return; // stop polling
        }
        const [transcript, vulnerabilities] = await Promise.all([
          fetchTranscript(activeRun).catch(() => ({ agents: [], events: [] })),
          fetchVulnerabilities(summary.runId, activeRun).catch(() => [] as Vulnerability[]),
        ]);
        if (cancelled) return;
        setRun((prev) => ({
          summary,
          raw,
          finished,
          transcript,
          vulnerabilities,
          reportMarkdown: prev?.reportMarkdown ?? null,
        }));
        schedule();
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Could not load run data.");
        schedule();
      }
    };

    (async () => {
      try {
        const full = await fetchAll(activeRun);
        if (cancelled) return;
        setRun(full);
        if (full.finished) {
          finishedRef.current = true;
        } else {
          schedule();
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Could not load run data.");
        schedule();
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeRun]);

  const counts = useMemo(
    () => (run ? severityCounts(run.vulnerabilities) : null),
    [run]
  );
  const selected = run?.vulnerabilities.find((v) => v.id === selectedId) ?? null;
  const agentCount = run?.transcript.agents.length ?? 0;
  const verified = auth?.verified === true;

  // Per-run guard for the default view: land on Agents while a scan is live,
  // Overview once it finishes. Applied at most once per run and never once the
  // user has navigated manually (userSetView flips the guard).
  const initialViewAppliedRef = useRef(false);

  // Reset the guard whenever the active run changes so the newly selected run
  // gets its own default.
  useEffect(() => {
    initialViewAppliedRef.current = false;
  }, [activeRun]);

  useEffect(() => {
    if (initialViewAppliedRef.current || !run) return;
    if (run.finished) {
      initialViewAppliedRef.current = true;
      setView("overview");
    } else if (agentCount > 0) {
      // Live and agents have appeared: default to the agent graph. If it is
      // live but no agents exist yet, wait (do not apply, do not set the flag).
      initialViewAppliedRef.current = true;
      setView("agents");
    }
  }, [run, agentCount]);

  // User-initiated navigation: mark the default guard applied so the per-run
  // default effect never yanks the user off the view they chose.
  const userSetView = useCallback((v: View) => {
    initialViewAppliedRef.current = true;
    setView(v);
  }, []);

  const selectRun = useCallback((name: string) => {
    setActiveRun(name);
    setSelectedId(null);
    setRun(null);
    setError(null);
    // Reset the guard so the per-run default applies to the newly selected run.
    initialViewAppliedRef.current = false;
  }, []);

  const goEmail = useCallback((skipDisclosure: boolean, surface: string) => {
    trackCta("email_report", surface);
    setEmailPurpose("report");
    setEmailSkipDisclosure(skipDisclosure);
    userSetView("email");
  }, [userSetView]);

  // Nav entry keeps the disclosure (first place those users see it);
  const openEmail = useCallback(() => goEmail(false, "nav"), [goEmail]);
  // the Overview CTA already states the tradeoff, so it starts the flow directly.
  const openEmailFromOverview = useCallback(() => goEmail(true, "overview"), [goEmail]);

  const openHistory = useCallback(() => {
    void refreshRuns();
    userSetView("history");
  }, [refreshRuns, userSetView]);

  const onPastRunsVerified = useCallback(async () => {
    await refreshAuth();
    await refreshRuns();
  }, [refreshAuth, refreshRuns]);

  const onForget = useCallback(async () => {
    await forgetAuth();
    await refreshAuth();
    await refreshRuns();
  }, [refreshAuth, refreshRuns]);

  const navProps = {
    view,
    onSelectView: (v: View) => {
      // Selecting a nav view always lands on that section's top level, so
      // leaving a specific issue's detail view and tapping "Issues" returns
      // to the full findings list.
      setSelectedId(null);
      if (v === "history") openHistory();
      else userSetView(v);
    },
    issuesCount: run?.vulnerabilities.length ?? 0,
    agentCount,
    runCount: runs?.count ?? 0,
    finished: run?.finished ?? false,
    verified,
    email: auth?.email ?? null,
    onOpenEmail: openEmail,
    onOpenHistory: openHistory,
    onForget: () => void onForget(),
  };

  return (
    <div className="min-h-screen bg-black text-white lg:flex">
      <DesktopNav {...navProps} />

      <div className="min-w-0 flex-1">
        {/* Top bar */}
        <div className="sticky top-0 z-30 border-b border-white/10 bg-black/95 backdrop-blur">
          <div className="mx-auto flex max-w-4xl items-center gap-2 px-4 py-3.5 sm:px-6">
            <div className="flex items-center gap-1.5 lg:hidden">
              <img src="./logo.png" alt="Strix" className="h-6 w-8 object-cover" />
              <span className="text-sm font-medium tracking-tight text-white">Strix</span>
            </div>
            {run && <LiveIndicator finished={run.finished} />}
            <div className="ml-auto flex items-center gap-2">
              {verified && runs && !runs.locked && runs.runs.length > 0 && (
                <RunSwitcher
                  runs={runs}
                  activeRun={activeRun}
                  launchedName={runTitle(run?.summary.targets[0] ?? null, run?.summary.runName ?? run?.summary.runId ?? "Current run")}
                  onSelect={selectRun}
                />
              )}
            </div>
          </div>
        </div>

        <main className="mx-auto max-w-4xl space-y-6 px-4 py-6 pb-24 sm:px-6 sm:py-10 lg:pb-10">
          {error && !run && view !== "history" && view !== "email" && (
            <div className="flex items-start gap-3 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3">
              <AlertCircle className="h-5 w-5 flex-shrink-0 mt-0.5 text-red-400" aria-hidden="true" />
              <p className="text-sm text-red-300">{error}</p>
            </div>
          )}

          {/* Keyed wrapper: re-mounts on every view / finding / run change so the
              page-in transition replays. */}
          <div
            key={`${activeRun ?? "launched"}:${view}:${selectedId ?? ""}`}
            className="animate-page-in space-y-6"
          >
          {view === "email" ? (
            <EmailReportView
              activeRun={activeRun}
              auth={auth}
              purpose={emailPurpose}
              skipDisclosure={emailSkipDisclosure}
              onAuthChanged={() => {
                void refreshAuth();
                void refreshRuns();
              }}
              onExit={(dest) => setView(dest === "history" ? "history" : "overview")}
            />
          ) : view === "feedback" ? (
            <FeedbackView
              defaultEmail={auth?.email ?? null}
              onExit={(dest) => setView(dest)}
            />
          ) : view === "history" ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <History className="w-5 h-5 text-white/45" aria-hidden="true" />
                <h1 className="text-xl font-semibold text-white sm:text-2xl">Past runs</h1>
              </div>
              <PastRunsView
                runs={runs}
                activeRun={activeRun}
                onSelectRun={selectRun}
                onVerified={() => void onPastRunsVerified()}
              />
            </div>
          ) : !run && !error ? (
            <div className={`${card} ${cardPad} text-center py-10`}>
              <div className="w-6 h-6 mx-auto mb-3 rounded-full border-2 border-white/15 border-t-white animate-spin" />
              <p className="text-sm text-white/45">Loading run data…</p>
            </div>
          ) : run && counts ? (
            <>
              <SummaryHeader summary={run.summary} />

              {view === "overview" ? (
                <OverviewTab
                  summary={run.summary}
                  counts={counts}
                  total={run.vulnerabilities.length}
                  reportMarkdown={run.reportMarkdown}
                  raw={run.raw}
                  finished={run.finished}
                  onOpenEmail={openEmailFromOverview}
                />
              ) : view === "agents" && agentCount > 0 ? (
                <AgentsTab run={run} canSteer={canSteer} />
              ) : selected ? (
                <div className="space-y-4">
                  <button
                    onClick={() => setSelectedId(null)}
                    className="cursor-pointer inline-flex items-center gap-1.5 text-sm text-white/50 hover:text-white transition-colors"
                  >
                    <ArrowLeft className="w-4 h-4" /> Back to all findings
                  </button>
                  <VulnerabilityDetail vulnerability={selected} />
                </div>
              ) : (
                <FindingsList
                  vulnerabilities={run.vulnerabilities}
                  finished={run.finished}
                  onSelect={(id) => setSelectedId(id)}
                />
              )}
            </>
          ) : null}
          </div>
        </main>
      </div>

      <MobileNav {...navProps} />
      <TrustToast message={TRUST_BANNER} />
    </div>
  );
}

function RunSwitcher({
  runs,
  activeRun,
  launchedName,
  onSelect,
}: {
  runs: RunsPayload;
  activeRun: string | null;
  launchedName: string;
  onSelect: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const activeEntry = runs.runs.find((r) => r.name === activeRun);
  const current = activeEntry ? runTitle(activeEntry.target, activeEntry.name) : launchedName;
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        aria-label="Switch pentest"
        className="flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-2.5 py-2 text-sm text-white transition-colors hover:border-white/30 hover:bg-white/[0.08]"
      >
        <History className="h-4 w-4 flex-shrink-0 text-white/45" aria-hidden="true" />
        <span className="hidden max-w-[200px] truncate font-medium sm:inline">{current}</span>
        <ChevronDown className="h-4 w-4 flex-shrink-0 text-white/45" aria-hidden="true" />
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 max-h-96 w-[min(90vw,24rem)] overflow-y-auto rounded-xl border border-white/10 bg-[#0a0a0a] py-1.5 shadow-2xl">
          <div className="border-b border-white/10 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-white/35">
            Switch pentest
          </div>
          {runs.runs.map((r) => {
            const active = r.name === activeRun;
            return (
              <button
                key={r.name}
                onMouseDown={() => onSelect(r.name)}
                className={`flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm transition-colors hover:bg-white/[0.06] ${
                  active ? "bg-white/[0.04] text-white" : "text-white/60"
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{runTitle(r.target, r.name)}</span>
                  {r.target && <span className="block truncate font-mono text-xs text-white/35">{r.target}</span>}
                </span>
                {active && <span className="h-2 w-2 flex-shrink-0 rounded-full bg-emerald-400" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function LiveIndicator({ finished }: { finished: boolean }) {
  if (finished) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-white/45">
        <span className="w-1.5 h-1.5 rounded-full bg-white/30" />
        Complete
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
      <span className="relative flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
      </span>
      Live
    </span>
  );
}

function formatDuration(seconds: number | null): string | null {
  if (seconds == null) return null;
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function SummaryHeader({ summary }: { summary: ParsedRunSummary }) {
  const duration = formatDuration(summary.durationSeconds);
  return (
    <div>
      <h1 className="text-xl font-semibold text-white sm:text-2xl">
        {runTitle(summary.targets[0] ?? null, summary.runName ?? summary.runId ?? "Pentest results")}
      </h1>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-white/45">
        {summary.targets.length > 0 && (
          <span className="font-mono text-white/60 break-all">{summary.targets.join(", ")}</span>
        )}
        {summary.scanMode && <Meta label={summary.scanMode} />}
        {duration && <Meta label={duration} />}
        {summary.status && <Meta label={summary.status} />}
      </div>
    </div>
  );
}

function Meta({ label }: { label: string }) {
  return (
    <>
      <span className="text-white/20">·</span>
      <span className="capitalize">{label}</span>
    </>
  );
}

function FindingsList({
  vulnerabilities,
  finished,
  onSelect,
}: {
  vulnerabilities: Vulnerability[];
  finished: boolean;
  onSelect: (id: string) => void;
}) {
  const sorted = [...vulnerabilities].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
  );
  if (sorted.length === 0) {
    return (
      <div className={`${card} ${cardPad} text-center text-sm text-white/45 py-10`}>
        {finished ? "No findings in this run." : "No findings yet. The pentest is still running…"}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {sorted.map((v) => (
        <button
          key={v.id}
          onClick={() => onSelect(v.id)}
          className="animate-card-in cursor-pointer w-full text-left rounded-xl border border-white/10 hover:border-white/25 bg-white/[0.02] px-4 py-3.5 transition-colors flex items-center gap-3"
        >
          <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${getSeverityDot(v.severity)}`} aria-hidden="true" />
          <span className="flex-1 min-w-0">
            <span className="block text-sm font-medium text-white truncate">{v.title}</span>
            {v.target && (
              <span className="block text-xs text-white/40 font-mono truncate">{v.target}</span>
            )}
          </span>
          <span
            className={`text-xs font-semibold px-2 py-0.5 rounded-full border capitalize ${SEVERITY_COLORS[v.severity]}`}
          >
            {v.severity}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Strip a single leading markdown heading (report sections embed their own). */
function stripLeadingHeading(md: string): string {
  return md.replace(/^\s*#{1,6}[ \t]+.*(?:\r?\n)+/, "").trimStart();
}

function dedupeHeadings(md: string): string {
  const out: string[] = [];
  let lastHeading: string | null = null;
  for (const line of md.split("\n")) {
    const m = line.match(/^#{1,6}\s+(.*)$/);
    if (m) {
      const norm = m[1].trim().toLowerCase();
      if (norm === lastHeading) continue;
      lastHeading = norm;
    } else if (line.trim() !== "") {
      lastHeading = null;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** Primary local CTA: email an encrypted PDF. Verify-email affordance, no lock. */
function EmailReportCta({ onOpenEmail }: { onOpenEmail: () => void }) {
  return (
    <button
      onClick={onOpenEmail}
      className="group w-full cursor-pointer rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.06] p-4 text-left transition-colors hover:border-emerald-500/40"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-emerald-500/30 bg-emerald-500/10">
            <Mail className="h-4 w-4 text-emerald-400" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-white">Email an encrypted PDF report of this run</p>
            <p className="mt-0.5 text-xs text-white/45">
              Encrypted with a key only you can see, email verified with a one-time code before sending.
            </p>
          </div>
        </div>
        <span className={`${primaryBtn} flex-shrink-0 w-full sm:w-auto`}>Export report to PDF</span>
      </div>
    </button>
  );
}

function OverviewTab({
  summary,
  counts,
  total,
  reportMarkdown,
  raw,
  finished,
  onOpenEmail,
}: {
  summary: ParsedRunSummary;
  counts: Record<VulnerabilitySeverity, number>;
  total: number;
  reportMarkdown: string | null;
  raw: Record<string, unknown>;
  finished: boolean;
  onOpenEmail: () => void;
}) {
  const sections = (
    [
      ["Executive Summary", summary.executiveSummary],
      ["Technical Analysis", summary.technicalAnalysis],
      ["Methodology", summary.methodology],
      ["Recommendations", summary.recommendations],
    ] as const
  )
    .filter(([, content]) => !!content)
    .map(([title, content]) => ({ title, content: stripLeadingHeading(content as string) }));

  return (
    <div className="space-y-6">
      <div className="animate-card-in">
        <RunDetails raw={raw} durationSeconds={summary.durationSeconds} />
      </div>

      {total > 0 && (
        <div className={`animate-card-in ${card} ${cardPad}`}>
          <IssueSeveritySummary findings={{ total, ...counts }} />
        </div>
      )}

      {/* Primary CTA: the one primary on Overview. Hidden until the run is
          finished, since a live scan would only email a partial report. */}
      {finished && (
        <div className="animate-card-in">
          <EmailReportCta onOpenEmail={onOpenEmail} />
        </div>
      )}

      {sections.length > 0 ? (
        <div className={`animate-card-in ${card} ${cardPad} space-y-8`}>
          {sections.map((s) => (
            <ContentSection key={s.title} title={s.title} content={s.content} />
          ))}
        </div>
      ) : reportMarkdown ? (
        <div className={`animate-card-in ${card} ${cardPad}`}>
          <ContentSection content={dedupeHeadings(reportMarkdown)} />
        </div>
      ) : (
        total === 0 && (
          <p className="text-sm text-white/45">No summary available for this run yet.</p>
        )
      )}

    </div>
  );
}

function AgentsTab({ run, canSteer }: { run: LoadedRun; canSteer: boolean }) {
  const { agents, events } = run.transcript;
  const graphAgents = useMemo(() => buildGraphAgents(agents, events), [agents, events]);
  // Clicking a graph node opens the agent's transcript in a modal; no node selected means no modal.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedAgent = selectedId ? (agents.find((a) => a.id === selectedId) ?? null) : null;

  // Live steering is only possible in-process (canSteer) while the scan runs.
  const steerable = canSteer && !run.finished;

  return (
    <div className="space-y-5">
      <div className={`${card} ${cardPad}`}>
        <div className="flex items-center gap-2">
          <Bot className="w-4 h-4 text-white/45" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-white">Agent graph</h2>
          <span className="text-xs text-white/35">
            {agents.length} agent{agents.length === 1 ? "" : "s"}
          </span>
        </div>
        <p className="mt-1 mb-4 text-xs text-white/35">
          Tap an agent to open its full transcript.
        </p>
        <div className="h-[65vh] sm:h-[480px] rounded-xl border border-white/10 overflow-hidden">
          <AgentGraph
            agents={graphAgents}
            selectedAgentId={selectedId}
            onSelectAgent={(id) => setSelectedId(id)}
            eventsLoaded
            eventsEmpty={graphAgents.size === 0}
            scanCompleted={run.finished}
          />
        </div>
      </div>

      {/* Live steering: only in-process while the scan runs. Otherwise omitted. */}
      {steerable && <ScanPromptComposer agents={agents} />}

      <AgentDetailModal
        open={selectedAgent !== null}
        agent={selectedAgent}
        events={events}
        steerable={steerable}
        onClose={() => setSelectedId(null)}
      />
    </div>
  );
}
