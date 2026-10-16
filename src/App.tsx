import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Archive,
  Bot,
  Clock,
  FileDown,
  Users,
  ArrowDown,
  ChevronDown,
  ChevronRight,
  MessagesSquare,
  Moon,
  RefreshCw,
  Search,
  Sun,
  MoreHorizontal,
  Loader2,
  Wrench,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ClaudeLogo } from "@/claude-logo";
import { accountLabel, setAccountNames, chatActions, fmtDate, fmtSize, type Chat, type ChatAction, type Msg, type AccountInfo } from "@/chat-actions";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type Hit = { id: string; snippet: string };

const PAGE_SIZE = 20;

function useToast() {
  const [msg, setMsg] = useState<string | null>(null);
  const show = useCallback((m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 2200);
  }, []);
  return { msg, show };
}

export default function App() {
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Record<string, string> | null>(null);
  const [searching, setSearching] = useState(false);
  const [account, setAccount] = useState<string>("all");
  const [selected, setSelected] = useState<Chat | null>(null);
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [showTools, setShowTools] = useState(false);
  const [dark, setDark] = useState(() => localStorage.getItem("theme") !== "light");
  const toast = useToast();

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);

  const [accountInfo, setAccountInfo] = useState<AccountInfo[]>([]);
  const load = useCallback(() => {
    setChats(null);
    invoke<AccountInfo[]>("account_info")
      .then((a) => {
        setAccountNames(a);
        setAccountInfo(a);
      })
      .catch(() => {});
    invoke<Chat[]>("list_chats").then(setChats).catch((e) => setError(String(e)));
  }, []);
  useEffect(load, [load]);

  const open = useCallback((chat: Chat) => {
    setSelected(chat);
    setMsgs(null);
    invoke<Msg[]>("read_chat", { path: chat.path })
      .then(setMsgs)
      .catch((e) => {
        setMsgs([]);
        toast.show(String(e));
      });
  }, [toast]);

  const tag = (id: string) => {
    const a = accountInfo.find((x) => x.id === id);
    const parts = [a?.desktopCurrent && "Desktop", a?.cliCurrent && "CLI"].filter(Boolean);
    return parts.length ? ` · ${parts.join(" + ")}` : "";
  };
  const accounts = useMemo(() => {
    const m = new Map<string, number>();
    chats?.forEach((c) => m.set(c.account, (m.get(c.account) ?? 0) + 1));
    return [...m.entries()];
  }, [chats]);

  const visible = useMemo(() => {
    if (!chats) return [];
    const q = query.trim().toLowerCase();
    return chats.filter((c) => {
      if (account !== "all" && c.account !== account) return false;
      if (hits) return c.id in hits;
      return !q || c.title.toLowerCase().includes(q) || c.project.toLowerCase().includes(q);
    });
  }, [chats, query, account, hits]);

  const viewerRef = useRef<HTMLDivElement | null>(null);
  const [showJump, setShowJump] = useState(false);
  const viewport = () =>
    viewerRef.current?.querySelector<HTMLElement>("[data-slot=scroll-area-viewport]") ?? null;
  useEffect(() => {
    const el = viewport();
    if (!el) return;
    const onScroll = () => setShowJump(el.scrollHeight - el.scrollTop - el.clientHeight > 400);
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [selected, msgs, showTools]);

  useEffect(() => {
    const el = viewport();
    if (el) el.scrollTop = 0;
  }, [selected]);

  const [limit, setLimit] = useState(PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => setLimit(PAGE_SIZE), [query, account, hits, chats]);
  const hasMore = visible.length > limit;
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    let timer: number | undefined;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && timer === undefined) {
        timer = window.setTimeout(() => {
          setLimit((l) => l + PAGE_SIZE);
          timer = undefined;
        }, 300);
      }
    });
    io.observe(el);
    return () => {
      io.disconnect();
      window.clearTimeout(timer);
    };
  }, [hasMore, limit]);

  const runSearch = async () => {
    if (query.trim().length < 2) return setHits(null);
    setSearching(true);
    try {
      const res = await invoke<Hit[]>("search_chats", { query });
      setHits(Object.fromEntries(res.map((h) => [h.id, h.snippet])));
    } catch (e) {
      toast.show(String(e));
    } finally {
      setSearching(false);
    }
  };

  const shown = msgs?.filter((m) => showTools || m.kind !== "tool") ?? [];

  return (
    <TooltipProvider delay={200}>
      <div className="flex h-screen bg-background text-foreground">
        {/* Sidebar */}
        <aside className="flex w-[360px] shrink-0 flex-col border-r">
          <div className="flex items-center gap-2 p-3">
            <div className="flex size-8 items-center justify-center rounded-lg bg-muted">
              <MessagesSquare className="size-4 text-muted-foreground" strokeWidth={1.5} />
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="text-base font-medium leading-tight">ChatVault</h1>
              <p className="truncate text-xs text-muted-foreground">
                {chats ? `${chats.length} chats found on this PC` : "Scanning…"}
              </p>
            </div>
          </div>

          <div className="space-y-2 px-3 pb-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
              <Input
                className="h-9 pl-8"
                placeholder="Filter by title, or press Enter to search inside chats"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setHits(null);
                }}
                onKeyDown={(e) => e.key === "Enter" && runSearch()}
              />
            </div>
            <Select
              value={account}
              onValueChange={(v) => v && setAccount(v)}
              items={{ all: `All accounts · ${chats?.length ?? 0}`, ...Object.fromEntries(accounts.map(([a, n]) => [a, `${accountLabel(a)} · ${n}${tag(a)}`])) }}
            >
              <SelectTrigger className="h-9 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All accounts · {chats?.length ?? 0}</SelectItem>
                {accounts.map(([a, n]) => (
                  <SelectItem key={a} value={a}>
                    {accountLabel(a)} · {n}{tag(a)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {searching && <p className="text-xs text-muted-foreground">Searching inside every chat…</p>}
            {hits && !searching && (
              <p className="text-xs text-muted-foreground">
                {Object.keys(hits).length} chats contain “{query}”.{" "}
                <button className="underline" onClick={() => setHits(null)}>
                  Clear
                </button>
              </p>
            )}
          </div>
          <Separator />

          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-0.5 p-1.5">
              {error && <p className="p-3 text-sm text-destructive">{error}</p>}
              {!chats && !error && Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
              {chats && visible.length === 0 && (
                <div className="flex flex-col items-center gap-2 p-8 text-center">
                  <Search className="size-8 text-muted-foreground" strokeWidth={1.25} />
                  <p className="text-sm font-medium">No Chats Found</p>
                  <p className="text-xs text-muted-foreground">Try a different word or account.</p>
                </div>
              )}
              {visible.slice(0, limit).map((c) => (
                <div
                  key={c.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => open(c)}
                  onKeyDown={(e) => e.key === "Enter" && open(c)}
                  className={cn(
                    "group w-full cursor-pointer rounded-lg border border-transparent px-2.5 py-2 text-left transition hover:bg-muted",
                    selected?.id === c.id && "border-border bg-muted",
                  )}
                >
                  <div className="flex items-start gap-2.5">
                    <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                      <ClaudeLogo className="size-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.title}</span>
                    {c.archived && <Archive className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.5} />}
                    <ChatMenu chat={c} toast={toast.show} msgs={selected?.id === c.id ? msgs : null} />
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="truncate">{c.project}</span>
                    <span>·</span>
                    <span className="shrink-0">{fmtDate(c.lastMs)}</span>
                  </div>
                  {hits?.[c.id] && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{hits[c.id]}</p>}
                    </div>
                  </div>
                </div>
              ))}
              {visible.length > limit && (
                <div ref={sentinelRef} className="space-y-0.5">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} className="h-16 w-full" />
                  ))}
                </div>
              )}
            </div>
          </ScrollArea>
        </aside>

        {/* Viewer */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
            <p className="min-w-0 flex-1 truncate text-sm font-medium">{selected ? selected.title : "All chats"}</p>
            <Tip label="Scan this PC for chats again.">
              <Button variant="ghost" size="icon" onClick={load} aria-label="Refresh">
                <RefreshCw className="size-4" />
              </Button>
            </Tip>
            <Tip label={dark ? "Switch to light theme" : "Switch to dark theme"}>
              <Button variant="ghost" size="icon" onClick={() => setDark((d) => !d)} aria-label="Toggle theme">
                {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
              </Button>
            </Tip>
          </div>
          {!selected ? (
            <div className="flex flex-1 items-center justify-center overflow-auto p-6">
              <div className="w-full max-w-xl space-y-6 text-center">
                <div className="mx-auto flex size-12 items-center justify-center rounded-xl bg-muted">
                  <MessagesSquare className="size-6 text-muted-foreground" strokeWidth={1.25} />
                </div>
                <div className="space-y-1">
                  <h2 className="text-base font-medium">Pick a chat to read it</h2>
                  <p className="text-sm text-muted-foreground">
                    Chats from every Claude account used on this computer are listed on the left.
                  </p>
                </div>
                <div className="grid grid-cols-3 gap-2 text-left">
                  {[
                    { icon: MessagesSquare, n: chats?.length ?? "…", label: "Chats found" },
                    { icon: Users, n: accounts.length || "…", label: "Accounts" },
                    { icon: Clock, n: chats?.[0] ? fmtDate(chats[0].lastMs) : "…", label: "Latest activity" },
                  ].map((s) => (
                    <div key={s.label} className="rounded-lg border bg-card p-3">
                      <s.icon className="mb-2 size-4 text-muted-foreground" strokeWidth={1.5} />
                      <p className="truncate text-sm font-medium">{s.n}</p>
                      <p className="text-xs text-muted-foreground">{s.label}</p>
                    </div>
                  ))}
                </div>
                <div className="space-y-2 text-left">
                  {[
                    { icon: Search, title: "Search inside chats", text: "Type a word and press Enter to search the full text of every chat." },
                    { icon: Bot, title: "Continue anywhere", text: "Use the three dots on a chat to continue it in Claude Code or Codex." },
                    { icon: FileDown, title: "Keep a copy", text: "Save any chat as a Markdown file or a handoff file." },
                  ].map((s) => (
                    <div key={s.title} className="flex items-start gap-3 rounded-lg border p-3">
                      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                        <s.icon className="size-4 text-muted-foreground" strokeWidth={1.5} />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{s.title}</p>
                        <p className="text-xs text-muted-foreground">{s.text}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <>
              <header className="space-y-2 border-b p-4">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-base font-medium">{selected.title}</h2>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <Badge variant="outline">{accountLabel(selected.account)}</Badge>
                      <Badge variant="outline">{selected.project}</Badge>
                      {selected.model && <Badge variant="outline">{selected.model}</Badge>}
                      <span className="text-xs text-muted-foreground">
                        {fmtDate(selected.lastMs)} · {fmtSize(selected.size)} · {msgs ? shown.length : "…"} messages
                      </span>
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {chatActions(selected, toast.show, msgs)
                    .filter((a) => a.id === "claude" || a.id === "codex")
                    .map((a) => (
                      <Tip key={a.id} label={a.hint}>
                        <ActionButton action={a} primary={a.id === "claude"} onError={toast.show} />
                      </Tip>
                    ))}
                  <ActionsMenu chat={selected} msgs={msgs} toast={toast.show} />
                  <div className="ml-auto">
                    <Tip label={showTools ? "Hide the tool steps" : "Show the tool steps Claude took"}>
                      <Button
                        size="icon"
                        variant={showTools ? "secondary" : "ghost"}
                        aria-label="Toggle tool steps"
                        onClick={() => setShowTools((s) => !s)}
                      >
                        <Wrench className="size-4" strokeWidth={1.5} />
                      </Button>
                    </Tip>
                  </div>
                </div>
              </header>

              <div ref={viewerRef} className="relative min-h-0 flex-1">
                <ScrollArea className="h-full">
                  <div className="mx-auto max-w-3xl space-y-4 p-4">
                    {!msgs && Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-20 w-full" />)}
                    {shown.map((m, i) => (
                      <Message key={i} m={m} />
                    ))}
                  </div>
                </ScrollArea>
                {showJump && (
                  <Button
                    size="icon"
                    variant="outline"
                    aria-label="Scroll to the bottom"
                    className="absolute bottom-4 left-1/2 size-9 -translate-x-1/2 rounded-full bg-background shadow-md"
                    onClick={() => viewport()?.scrollTo({ top: viewport()!.scrollHeight, behavior: "smooth" })}
                  >
                    <ArrowDown className="size-4" />
                  </Button>
                )}
              </div>
            </>
          )}
        </main>

        {toast.msg && (
          <div className="fixed bottom-4 right-4 rounded-lg border bg-popover px-3 py-2 text-sm shadow-md">{toast.msg}</div>
        )}
      </div>
    </TooltipProvider>
  );
}

function Tip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children as ReactElement} />
      <TooltipContent className="max-w-xs">{label}</TooltipContent>
    </Tooltip>
  );
}

function Message({ m }: { m: Msg }) {
  const [open, setOpen] = useState(false);
  const time = m.ts ? new Date(m.ts).toLocaleTimeString(undefined, { timeStyle: "short" }) : "";

  if (m.kind === "tool") {
    return (
      <div className="flex items-center gap-2 pl-2 text-xs text-muted-foreground">
        <Wrench className="size-3 shrink-0" strokeWidth={1.5} />
        <span className="truncate font-mono">{m.text}</span>
      </div>
    );
  }
  if (m.kind === "summary") {
    return (
      <div className="rounded-lg border border-dashed p-3 text-sm">
        <button className="flex items-center gap-1.5 text-muted-foreground" onClick={() => setOpen((o) => !o)}>
          {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          Earlier part was summarized here
        </button>
        {open && <pre className="mt-2 whitespace-pre-wrap font-sans text-xs text-muted-foreground">{m.text}</pre>}
      </div>
    );
  }
  const isUser = m.role === "user";
  const long = m.text.length > 1800;
  const text = long && !open ? m.text.slice(0, 1800) + "…" : m.text;
  return (
    <div className={cn("flex", isUser && "justify-end")}>
      <div className={cn("max-w-[88%] rounded-xl border px-3.5 py-2.5", isUser ? "bg-muted" : "bg-card")}>
        <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{isUser ? "You" : "Claude"}</span>
          <span>{time}</span>
        </div>
        <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">{text}</pre>
        {long && (
          <button className="mt-1 text-xs text-muted-foreground underline" onClick={() => setOpen((o) => !o)}>
            {open ? "Show less" : "Show all"}
          </button>
        )}
      </div>
    </div>
  );
}


function useRun(onError: (m: string) => void) {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

function ActionButton({ action, primary, onError }: { action: ChatAction; primary?: boolean; onError: (m: string) => void }) {
  const { busy, run } = useRun(onError);
  const Icon = action.icon;
  return (
    <Button size="sm" variant={primary ? "default" : "outline"} disabled={busy} onClick={() => run(action.run)}>
      {busy ? <Loader2 className="size-4 animate-spin" /> : <Icon className="size-4" />} {action.label}
    </Button>
  );
}

function ChatMenu({ chat, toast, msgs }: { chat: Chat; toast: (m: string) => void; msgs: Msg[] | null }) {
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const actions = chatActions(chat, toast, msgs).filter((a) => ["claude", "codex", "open", "reveal", "copy-md"].includes(a.id));
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);
  const groups = ["Continue", "Open", "Copy"] as const;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label="Chat actions"
            className="-my-1 size-7 shrink-0 text-muted-foreground"
            onClick={(e) => e.stopPropagation()}
          />
        }
      >
        <MoreHorizontal className="size-4" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 gap-0 p-1" onClick={(e) => e.stopPropagation()}>
        {groups.map((g, gi) => {
          const items = actions.filter((a) => a.group === g);
          if (!items.length) return null;
          return (
            <div key={g}>
              {gi > 0 && <Separator className="my-1" />}
              <p className="px-2 pb-0.5 pt-1.5 text-xs text-muted-foreground">{g}</p>
              {items.map((a) => {
                const Icon = a.icon;
                return (
                  <button
                    key={a.id}
                    title={a.hint}
                    disabled={busyId !== null}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-60"
                    onClick={async () => {
                      setBusyId(a.id);
                      try {
                        await a.run();
                        setOpen(false);
                      } catch (e) {
                        toast(String(e));
                      } finally {
                        setBusyId(null);
                      }
                    }}
                  >
                    {busyId === a.id ? <Loader2 className="size-4 animate-spin" /> : <Icon className="size-4 text-muted-foreground" strokeWidth={1.5} />}
                    {a.label}
                  </button>
                );
              })}
            </div>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}

function ActionsMenu({ chat, msgs, toast }: { chat: Chat; msgs: Msg[] | null; toast: (m: string) => void }) {
  const actions = chatActions(chat, toast, msgs).filter((a) => a.id !== "claude" && a.id !== "codex");
  const groups = ["Continue", "Open", "Copy", "Save"] as const;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size="sm" variant="outline" />}>
        <MoreHorizontal className="size-4" /> Actions <ChevronDown className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        {groups.map((g, gi) => {
          const items = actions.filter((a) => a.group === g);
          if (!items.length) return null;
          return (
            <div key={g}>
              {gi > 0 && <DropdownMenuSeparator />}
              <DropdownMenuGroup>
                <DropdownMenuLabel>{g}</DropdownMenuLabel>
                {items.map((a) => {
                  const Icon = a.icon;
                  return (
                    <DropdownMenuItem key={a.id} title={a.hint} onClick={() => a.run().catch((e) => toast(String(e)))}>
                      <Icon className="size-4" strokeWidth={1.5} /> {a.label}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuGroup>
            </div>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
