import { useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowUpRight, CalendarDays, DatabaseBackup, FolderOpen, HardDrive, LayoutDashboard, MessagesSquare, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ProviderLogo } from "@/claude-logo";
import { fmtSize, type Chat, type Provider } from "@/chat-actions";
import { ChatRowSkeleton } from "@/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

type Overview = { total: number; accounts: { id: string; count: number }[]; latestMs: number | null };
type Backup = { path: string; exists: boolean; files: number; bytes: number; lastSyncMs: number | null };
type Stats = {
  daily: { day: string; provider: Provider; count: number }[];
  projects: { name: string; count: number }[];
  sizeClaude: number;
  sizeCodex: number;
};

const DAYS = 14;
const CLAUDE = "#D97757";
const CODEX = "#7a9dff";

function when(ms: number) {
  const d = new Date(ms);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `Today, ${time}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday, ${time}`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function Card({ title, hint, action, children, className = "" }: { title: string; hint?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border bg-card ${className}`}>
      <div className="flex items-start justify-between gap-2 px-4 pt-3.5">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">{title}</h3>
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function IconBox({ children }: { children: ReactNode }) {
  return <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">{children}</div>;
}

export function OverviewPage({
  overview,
  accountCount,
  reloadKey,
  titleOf,
  onOpenChat,
  onSync,
  onSearch,
}: {
  overview: Record<Provider, Overview | null>;
  accountCount: number;
  reloadKey: number;
  titleOf: (c: Chat) => string;
  onOpenChat: (c: Chat) => void;
  onSync: () => void;
  onSearch: () => void;
}) {
  const [recent, setRecent] = useState<Chat[] | null>(null);
  const [backup, setBackup] = useState<Backup | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    let stale = false;
    Promise.all(
      (["claude", "codex"] as Provider[]).map((p) =>
        invoke<{ items: Chat[] }>("query_chats", { provider: p, account: "all", q: "", offset: 0, limit: 5 }).then((r) => r.items),
      ),
    )
      .then(([a, b]) => !stale && setRecent([...a, ...b].sort((x, y) => y.lastMs - x.lastMs).slice(0, 5)))
      .catch(() => !stale && setRecent([]));
    invoke<Backup>("backup_status").then((b) => !stale && setBackup(b)).catch(() => {});
    invoke<Stats>("overview_stats", { days: DAYS }).then((s) => !stale && setStats(s)).catch(() => {});
    return () => {
      stale = true;
    };
  }, [reloadKey]);

  const ready = overview.claude !== null && overview.codex !== null;
  const total = (overview.claude?.total ?? 0) + (overview.codex?.total ?? 0);

  // One column per day, oldest first, with a count for each tool.
  const days = useMemo(() => {
    const map = new Map<string, { claude: number; codex: number }>();
    stats?.daily.forEach((d) => {
      const e = map.get(d.day) ?? { claude: 0, codex: 0 };
      e[d.provider] += d.count;
      map.set(d.day, e);
    });
    return Array.from({ length: DAYS }, (_, i) => {
      const date = new Date();
      date.setDate(date.getDate() - (DAYS - 1 - i));
      const e = map.get(dayKey(date)) ?? { claude: 0, codex: 0 };
      return { date, ...e, total: e.claude + e.codex };
    });
  }, [stats]);
  const max = Math.max(1, ...days.map((d) => d.total));
  const week = days.slice(-7).reduce((n, d) => n + d.total, 0);
  const topProject = stats?.projects[0]?.count ?? 1;

  const cards = [
    { icon: <CalendarDays className="size-4 text-muted-foreground" strokeWidth={1.5} />, value: stats ? week.toLocaleString() : undefined, label: "Active this week" },
    { icon: <ProviderLogo provider="claude" className="size-4" />, value: overview.claude?.total.toLocaleString(), label: "Claude chats" },
    { icon: <ProviderLogo provider="codex" className="size-4" />, value: overview.codex?.total.toLocaleString(), label: "Codex chats" },
    { icon: <HardDrive className="size-4 text-muted-foreground" strokeWidth={1.5} />, value: stats ? fmtSize(stats.sizeClaude + stats.sizeCodex) : undefined, label: "Stored on this PC" },
  ];

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="flex min-h-full items-center justify-center p-6">
        <div className="w-full max-w-4xl space-y-4">
          <div className="flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted">
              <LayoutDashboard className="size-5 text-muted-foreground" strokeWidth={1.5} />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-medium leading-tight">Overview</h2>
              <p className="text-sm text-muted-foreground">
                {ready ? `${total.toLocaleString()} chats from ${accountCount} accounts on this computer` : "Looking for chats on this computer…"}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {cards.map((s) => (
              <div key={s.label} className="rounded-xl border bg-card p-4">
                <IconBox>{s.icon}</IconBox>
                <div className="mt-3 flex h-7 items-center">
                  {s.value === undefined ? <Skeleton className="h-5 w-16" /> : <p className="truncate text-xl font-medium tracking-tight">{s.value}</p>}
                </div>
                <p className="text-xs text-muted-foreground">{s.label}</p>
              </div>
            ))}
          </div>

          <div className="grid gap-4 lg:grid-cols-5">
            <div className="space-y-4 lg:col-span-3">
              <Card
                title="Activity"
                hint={`Chats you used each day, last ${DAYS} days`}
                action={
                  <div className="flex items-center gap-3 pt-0.5 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      <span className="size-2 rounded-full" style={{ background: CLAUDE }} /> Claude
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="size-2 rounded-full" style={{ background: CODEX }} /> Codex
                    </span>
                  </div>
                }
              >
                <div className="px-4 pb-3 pt-4">
                  {stats === null ? (
                    <Skeleton className="h-28 w-full" />
                  ) : (
                    <>
                      <div className="flex h-28 items-end gap-1.5">
                        {days.map((d) => (
                          <Tooltip key={d.date.toISOString()}>
                            <TooltipTrigger
                              render={
                                <div className="flex h-full min-w-0 flex-1 cursor-default flex-col justify-end">
                                  {d.total === 0 ? (
                                    <div className="h-1 rounded-full bg-muted" />
                                  ) : (
                                    <div className="flex flex-col-reverse overflow-hidden rounded-md" style={{ height: `${Math.max(8, (d.total / max) * 100)}%` }}>
                                      <div style={{ flex: d.claude, background: CLAUDE }} />
                                      <div style={{ flex: d.codex, background: CODEX }} />
                                    </div>
                                  )}
                                </div>
                              }
                            />
                            <TooltipContent>
                              {d.date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}: {d.claude} Claude, {d.codex} Codex
                            </TooltipContent>
                          </Tooltip>
                        ))}
                      </div>
                      <div className="mt-1.5 flex justify-between text-[10px] text-muted-foreground">
                        <span>{days[0].date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                        <span>Today</span>
                      </div>
                    </>
                  )}
                </div>
              </Card>

              <Card
                title="Pick up where you left off"
                action={
                  <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={onSearch}>
                    Search all <ArrowUpRight className="size-3" />
                  </Button>
                }
              >
                <div className="p-2 pt-1">
                  {recent === null ? (
                    Array.from({ length: 4 }).map((_, i) => <ChatRowSkeleton key={i} i={i} />)
                  ) : recent.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 p-8 text-center">
                      <MessagesSquare className="size-8 text-muted-foreground" strokeWidth={1.25} />
                      <p className="text-sm font-medium">No Chats Found</p>
                      <p className="text-xs text-muted-foreground">Chats appear here once Claude Code or Codex has been used.</p>
                    </div>
                  ) : (
                    recent.map((c) => (
                      <button key={`${c.provider}:${c.id}`} onClick={() => onOpenChat(c)} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-muted">
                        <IconBox>
                          <ProviderLogo provider={c.provider} className="size-5" />
                        </IconBox>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{titleOf(c)}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {c.project} · {when(c.lastMs)}
                          </p>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </Card>
            </div>

            <div className="space-y-4 lg:col-span-2">
              <Card title="Busiest projects" hint="Where most of your chats happen">
                <div className="space-y-3 px-4 pb-4 pt-3">
                  {stats === null
                    ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)
                    : stats.projects.slice(0, 5).map((p) => (
                        <div key={p.name} className="space-y-1.5">
                          <div className="flex items-center gap-2 text-sm">
                            <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.5} />
                            <span className="min-w-0 flex-1 truncate">{p.name}</span>
                            <span className="text-xs tabular-nums text-muted-foreground">{p.count.toLocaleString()}</span>
                          </div>
                          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                            <div className="h-full rounded-full bg-foreground/70" style={{ width: `${Math.max(4, (p.count / topProject) * 100)}%` }} />
                          </div>
                        </div>
                      ))}
                </div>
              </Card>

              <Card title="Backup">
                <div className="space-y-3 p-4 pt-3">
                  <div className="flex items-start gap-3">
                    <IconBox>
                      <DatabaseBackup className="size-4 text-muted-foreground" strokeWidth={1.5} />
                    </IconBox>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{backup?.lastSyncMs ? `Synced ${when(backup.lastSyncMs)}` : "Not backed up yet"}</p>
                      <p className="text-xs text-muted-foreground">
                        {backup && backup.files > 0 ? `${backup.files.toLocaleString()} files · ${fmtSize(backup.bytes)} in Documents` : "Copy all chats to your Documents folder."}
                      </p>
                    </div>
                  </div>
                  <Button size="sm" variant="outline" className="w-full" onClick={onSync}>
                    Sync &amp; backup
                  </Button>
                </div>
              </Card>

              <div className="flex items-center gap-3 rounded-xl border bg-card p-4">
                <IconBox>
                  <ShieldCheck className="size-4 text-muted-foreground" strokeWidth={1.5} />
                </IconBox>
                <div className="min-w-0">
                  <p className="text-sm font-medium">Your chats stay on your desktop</p>
                  <p className="text-xs text-muted-foreground">Private to you. Nothing is uploaded.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
