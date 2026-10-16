import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowUpRight, Bot, Clock, DatabaseBackup, FileDown, LayoutDashboard, MessagesSquare, Search, ShieldCheck, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ProviderLogo } from "@/claude-logo";
import { fmtDate, fmtSize, type Chat, type Provider } from "@/chat-actions";
import { ChatRowSkeleton, StatSkeleton } from "@/skeletons";

type Overview = { total: number; accounts: { id: string; count: number }[]; latestMs: number | null };
type Backup = { path: string; exists: boolean; files: number; bytes: number; lastSyncMs: number | null };

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

function Card({ title, action, children, className = "" }: { title?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border bg-card ${className}`}>
      {title && (
        <div className="flex items-center justify-between gap-2 px-4 pb-1 pt-3.5">
          <h3 className="text-sm font-medium">{title}</h3>
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

  useEffect(() => {
    let stale = false;
    Promise.all(
      (["claude", "codex"] as Provider[]).map((p) =>
        invoke<{ items: Chat[] }>("query_chats", { provider: p, account: "all", q: "", offset: 0, limit: 6 }).then((r) => r.items),
      ),
    )
      .then(([a, b]) => !stale && setRecent([...a, ...b].sort((x, y) => y.lastMs - x.lastMs).slice(0, 6)))
      .catch(() => !stale && setRecent([]));
    invoke<Backup>("backup_status").then((b) => !stale && setBackup(b)).catch(() => {});
    return () => {
      stale = true;
    };
  }, [reloadKey]);

  const ready = overview.claude !== null && overview.codex !== null;
  const latest = Math.max(overview.claude?.latestMs ?? 0, overview.codex?.latestMs ?? 0);
  const total = (overview.claude?.total ?? 0) + (overview.codex?.total ?? 0);

  const stats = [
    { icon: <ProviderLogo provider="claude" className="size-4" />, value: overview.claude?.total.toLocaleString(), label: "Claude chats" },
    { icon: <ProviderLogo provider="codex" className="size-4" />, value: overview.codex?.total.toLocaleString(), label: "Codex chats" },
    { icon: <Users className="size-4 text-muted-foreground" strokeWidth={1.5} />, value: ready ? String(accountCount) : undefined, label: "Accounts" },
    { icon: <Clock className="size-4 text-muted-foreground" strokeWidth={1.5} />, value: ready ? (latest ? when(latest) : "None yet") : undefined, label: "Latest activity" },
  ];

  const tips = [
    { icon: Search, title: "Search inside chats", text: "Type a word in the sidebar and press Enter." },
    { icon: Bot, title: "Continue anywhere", text: "Open a chat's menu to continue it in Claude Code or Codex." },
    { icon: FileDown, title: "Keep a copy", text: "Save a chat as Markdown or a handoff file." },
  ];

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto w-full max-w-4xl space-y-4 p-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted">
            <LayoutDashboard className="size-5 text-muted-foreground" strokeWidth={1.5} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-medium leading-tight">Overview</h2>
            <p className="text-sm text-muted-foreground">
              {ready ? `${total.toLocaleString()} chats from Claude Code and Codex on this computer.` : "Looking for chats on this computer…"}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={onSearch}>
            <Search className="size-4" /> Search <kbd className="ml-1 rounded border bg-muted px-1 text-[10px]">Ctrl K</kbd>
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {stats.map((s) => (
            <div key={s.label} className="rounded-xl border bg-card p-4">
              <IconBox>{s.icon}</IconBox>
              <div className="mt-3 flex h-7 items-center">
                {s.value === undefined ? <StatSkeleton /> : <p className="truncate text-xl font-medium tracking-tight">{s.value}</p>}
              </div>
              <p className="text-xs text-muted-foreground">{s.label}</p>
            </div>
          ))}
        </div>

        <div className="grid gap-4 lg:grid-cols-5">
          <Card
            title="Recent chats"
            className="lg:col-span-3"
            action={
              <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={onSearch}>
                Find more <ArrowUpRight className="size-3" />
              </Button>
            }
          >
            <div className="p-2 pt-1">
              {recent === null ? (
                Array.from({ length: 5 }).map((_, i) => <ChatRowSkeleton key={i} i={i} />)
              ) : recent.length === 0 ? (
                <div className="flex flex-col items-center gap-2 p-8 text-center">
                  <MessagesSquare className="size-8 text-muted-foreground" strokeWidth={1.25} />
                  <p className="text-sm font-medium">No Chats Found</p>
                  <p className="text-xs text-muted-foreground">Chats appear here once Claude Code or Codex has been used.</p>
                </div>
              ) : (
                recent.map((c) => (
                  <button
                    key={`${c.provider}:${c.id}`}
                    onClick={() => onOpenChat(c)}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-muted"
                  >
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

          <div className="space-y-4 lg:col-span-2">
            <Card title="Backup">
              <div className="space-y-3 p-4 pt-2">
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

            <Card title="Good to know">
              <div className="px-2 pb-2 pt-1">
                {tips.map((s, i) => (
                  <div key={s.title}>
                    {i > 0 && <Separator className="mx-2 w-auto" />}
                    <div className="flex items-start gap-3 rounded-lg px-2 py-2.5">
                      <IconBox>
                        <s.icon className="size-4 text-muted-foreground" strokeWidth={1.5} />
                      </IconBox>
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{s.title}</p>
                        <p className="text-xs text-muted-foreground">{s.text}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </div>

        <div className="flex items-center gap-3 rounded-xl border bg-card p-4">
          <IconBox>
            <ShieldCheck className="size-4 text-muted-foreground" strokeWidth={1.5} />
          </IconBox>
          <div className="min-w-0">
            <p className="text-sm font-medium">Your chats stay on your desktop</p>
            <p className="text-xs text-muted-foreground">Private to you. Nothing is uploaded, and only update checks go online.</p>
          </div>
        </div>
        <p className="pb-2 text-center text-xs text-muted-foreground">Latest chat: {latest ? fmtDate(latest) : "none"}</p>
      </div>
    </div>
  );
}
