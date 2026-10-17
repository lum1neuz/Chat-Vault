import { useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { FadedScroll } from "@/faded-scroll";
import { ArrowUpRight, DatabaseBackup, HardDrive, MessagesSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppLogo, ProviderLogo } from "@/claude-logo";
import { PROVIDERS, fmtSize, type Chat, type Provider } from "@/chat-actions";
import { ChatRowSkeleton } from "@/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

type Overview = { total: number; accounts: { id: string; count: number }[]; latestMs: number | null };
type Backup = { path: string; exists: boolean; files: number; bytes: number; lastSyncMs: number | null };
type Stats = {
  daily: { day: string; provider: Provider; count: number }[];
  projects: { name: string; count: number; claude: number; codex: number; cursor: number; lastMs: number }[];
  sizeClaude: number;
  sizeCodex: number;
  sizeCursor?: number;
};

const DAYS = 14;
const CLAUDE = "#D97757";
const CODEX = "#7a9dff";
const CURSOR = "#2dd4bf";
const chartConfig: ChartConfig = {
  claude: { label: "Claude", color: CLAUDE },
  codex: { label: "Codex", color: CODEX },
  cursor: { label: "Cursor", color: CURSOR },
};

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return "Working late";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

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

function Card({ title, hint, action, icon, children, className = "" }: { icon?: ReactNode; title?: string; hint?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border bg-card ${className}`}>
      {(title || action) && (
        <div className="flex items-center justify-between gap-2 px-4 pt-3.5">
          <div className="flex min-w-0 items-center gap-3">
            {icon && <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">{icon}</div>}
            <div className="min-w-0">
              <h3 className="text-sm font-medium">{title}</h3>
              {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
            </div>
          </div>
          {action}
        </div>
      )}
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
  actions,
  userName,
}: {
  overview: Record<Provider, Overview | null>;
  accountCount: number;
  reloadKey: number;
  titleOf: (c: Chat) => string;
  onOpenChat: (c: Chat) => void;
  onSync: () => void;
  onSearch: () => void;
  actions?: ReactNode;
  userName?: string;
}) {
  // A full-height window has room for five recent chats; a smaller one shows four so the page still fits.
  const [shown, setShown] = useState(() => (window.innerHeight >= 1000 ? 5 : 4));
  useEffect(() => {
    const on = () => setShown(window.innerHeight >= 1000 ? 5 : 4);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const [recent, setRecent] = useState<Chat[] | null>(null);
  const [backup, setBackup] = useState<Backup | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    let stale = false;
    Promise.all(
      PROVIDERS.map((p) =>
        invoke<{ items: Chat[] }>("query_chats", { provider: p, account: "all", q: "", offset: 0, limit: 5 }).then((r) => r.items),
      ),
    )
      .then((all) => !stale && setRecent(all.flat().sort((x, y) => y.lastMs - x.lastMs).slice(0, 5)))
      .catch(() => !stale && setRecent([]));
    invoke<Backup>("backup_status").then((b) => !stale && setBackup(b)).catch(() => {});
    invoke<Stats>("overview_stats", { days: DAYS }).then((s) => !stale && setStats(s)).catch(() => {});
    return () => {
      stale = true;
    };
  }, [reloadKey]);

  const ready = overview.claude !== null && overview.codex !== null && overview.cursor !== null;
  const total = (overview.claude?.total ?? 0) + (overview.codex?.total ?? 0) + (overview.cursor?.total ?? 0);

  // One column per day, oldest first, with a count for each tool.
  const days = useMemo(() => {
    const map = new Map<string, { claude: number; codex: number; cursor: number }>();
    stats?.daily.forEach((d) => {
      const e = map.get(d.day) ?? { claude: 0, codex: 0, cursor: 0 };
      e[d.provider] += d.count;
      map.set(d.day, e);
    });
    return Array.from({ length: DAYS }, (_, i) => {
      const date = new Date();
      date.setDate(date.getDate() - (DAYS - 1 - i));
      const e = map.get(dayKey(date)) ?? { claude: 0, codex: 0, cursor: 0 };
      return { date, ...e, total: e.claude + e.codex + e.cursor };
    });
  }, [stats]);
  const chartData = days.map((d) => ({ label: d.date.toLocaleDateString(undefined, { month: "short", day: "numeric" }), claude: d.claude, codex: d.codex, cursor: d.cursor }));
  const week = days.slice(-7).reduce((n, d) => n + d.total, 0);

  const cards = [
    { icon: <ProviderLogo provider="claude" className="size-4" />, value: overview.claude?.total.toLocaleString(), label: "Claude chats" },
    { icon: <ProviderLogo provider="codex" className="size-4" />, value: overview.codex?.total.toLocaleString(), label: "Codex chats" },
    { icon: <ProviderLogo provider="cursor" className="size-4" />, value: overview.cursor?.total.toLocaleString(), label: "Cursor chats" },
    { icon: <HardDrive className="size-4 text-muted-foreground" strokeWidth={1.5} />, value: stats ? fmtSize(stats.sizeClaude + stats.sizeCodex) : undefined, label: "Stored on this PC" },
  ];

  return (
    <FadedScroll className="flex-1">
      <div className="flex min-h-full items-center justify-center p-6">
        <div className="w-full max-w-4xl space-y-4">
          <div className="flex items-center gap-3">
            <AppLogo className="size-10 shrink-0 rounded-xl ring-1 ring-border" />
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-medium leading-tight">
                {greeting()}
                {userName ? `, ${userName}` : ""}
              </h2>
              <p className="text-sm text-muted-foreground">
                {ready
                  ? `${total.toLocaleString()} chats across ${accountCount} accounts${stats ? `, ${week.toLocaleString()} active this week` : ""}`
                  : "Looking for chats on this computer…"}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">{actions}</div>
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

              <Card
                className="overflow-hidden"
                title="Activity"
                hint="Chats you used each day"
                action={
                  <div className="flex items-center gap-3 pt-0.5 text-xs text-muted-foreground">
                    {[
                      ["Claude", CLAUDE],
                      ["Codex", CODEX],
                      ["Cursor", CURSOR],
                    ].map(([name, color]) => (
                      <span key={name} className="flex items-center gap-1.5">
                        <span className="size-2 rounded-full" style={{ background: color }} /> {name}
                      </span>
                    ))}
                  </div>
                }
              >
                <div className="pt-4">
                  {stats === null ? (
                    <Skeleton className="mx-4 mb-4 h-40" />
                  ) : (
                    <ChartContainer config={chartConfig} className="h-40 w-full">
                      <AreaChart data={chartData} margin={{ left: 0, right: 0, top: 8, bottom: 0 }}>
                        <defs>
                          {PROVIDERS.map((p) => (
                            <linearGradient key={p} id={`fill-${p}`} x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor={`var(--color-${p})`} stopOpacity={0.6} />
                              <stop offset="95%" stopColor={`var(--color-${p})`} stopOpacity={0.05} />
                            </linearGradient>
                          ))}
                        </defs>
                        <CartesianGrid vertical={false} strokeDasharray="3 3" />
                        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={32} padding={{ left: 0, right: 0 }} tick={{ fontSize: 11 }} />
                        <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" />} />
                        {PROVIDERS.map((p) => (
                          <Area key={p} dataKey={p} type="monotone" stackId="a" stroke={`var(--color-${p})`} strokeWidth={1.5} fill={`url(#fill-${p})`} />
                        ))}
                      </AreaChart>
                    </ChartContainer>
                  )}
                </div>
              </Card>

          <div className="grid gap-4 lg:grid-cols-5">
            <div className="space-y-4 lg:col-span-3">
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
                    Array.from({ length: shown }).map((_, i) => <ChatRowSkeleton key={i} i={i} />)
                  ) : recent.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 p-8 text-center">
                      <MessagesSquare className="size-8 text-muted-foreground" strokeWidth={1.25} />
                      <p className="text-sm font-medium">No Chats Found</p>
                      <p className="text-xs text-muted-foreground">Chats appear here once Claude Code or Codex has been used.</p>
                    </div>
                  ) : (
                    recent.slice(0, shown).map((c) => (
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
              <Card icon={<HardDrive className="size-4 text-muted-foreground" strokeWidth={1.5} />} title="Storage by tool" hint="Where the space on this PC goes">
                <div className="space-y-3 p-4 pt-3">
                  {stats === null ? (
                    <Skeleton className="h-16 w-full" />
                  ) : (
                    (() => {
                      const rows = [
                        { name: "Claude", size: stats.sizeClaude, color: CLAUDE },
                        { name: "Codex", size: stats.sizeCodex, color: CODEX },
                        { name: "Cursor", size: stats.sizeCursor ?? 0, color: CURSOR },
                      ];
                      const total = rows.reduce((a, r) => a + r.size, 0) || 1;
                      return (
                        <>
                          <div className="flex h-2 overflow-hidden rounded-full bg-muted">
                            {rows.map((r) => (
                              <div key={r.name} style={{ width: `${(r.size / total) * 100}%`, background: r.color }} />
                            ))}
                          </div>
                          <ul className="space-y-1.5">
                            {rows.map((r) => (
                              <li key={r.name} className="flex items-center justify-between text-sm">
                                <span className="flex items-center gap-2">
                                  <span className="size-2 rounded-full" style={{ background: r.color }} /> {r.name}
                                </span>
                                <span className="text-xs tabular-nums text-muted-foreground">{fmtSize(r.size)}</span>
                              </li>
                            ))}
                          </ul>
                        </>
                      );
                    })()
                  )}
                </div>
              </Card>

              <Card>
                <div className="flex items-start gap-3 p-4">
                  <IconBox>
                    <DatabaseBackup className="size-4 text-muted-foreground" strokeWidth={1.5} />
                  </IconBox>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{backup?.lastSyncMs ? `Synced ${when(backup.lastSyncMs)}` : "Not backed up yet"}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {backup && backup.files > 0 ? `${backup.files.toLocaleString()} files · ${fmtSize(backup.bytes)} in Documents` : "Copy chats to Documents."}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" className="shrink-0 self-center" onClick={onSync}>
                    Sync &amp; backup
                  </Button>
                </div>
              </Card>
            </div>
          </div>
        </div>
      </div>
    </FadedScroll>
  );
}
