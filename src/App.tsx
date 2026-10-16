import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Archive,
  ChevronRight,
  DatabaseBackup,
  Eye,
  FolderOpen,
  Trash2,
  ArrowUpDown,
  ListFilter,
  RotateCcw,
  LayoutDashboard,
  Loader2,
  MessagesSquare,
  Moon,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Search,
  Sun,
  Users,
} from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toaster } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ProviderLogo } from "@/claude-logo";
import { accountLabel, chatActions, fmtDate, setAccountNames, type AccountInfo, type Chat, type ChatAction, type Msg, type MsgPage, type Provider } from "@/chat-actions";
import { ChatView } from "@/chat-view";
import { OverviewPage } from "@/overview";
import { CommandPalette } from "@/command-palette";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarSkeleton } from "@/skeletons";
import { AUTO_SYNC_KEY, SyncDialog } from "@/sync-dialog";
import { chatKey, useChatMeta, usePersisted } from "@/store";
import { startAutoUpdate } from "@/updater";
import { toast as sonner } from "sonner";

const PAGE_SIZE = 20;
const MSG_PAGE = 400;

type Overview = { total: number; accounts: { id: string; count: number }[]; latestMs: number | null };
type Hit = { id: string; snippet: string };
type IndexProg = { phase: string; done: number; total: number };

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export default function App() {
  const [provider, setProvider] = usePersisted<Provider>("chatvault.provider", "claude");
  const [accounts, setAccounts] = usePersisted<Record<string, string>>("chatvault.accounts", {});
  const [showSteps, setShowSteps] = usePersisted("chatvault.steps", true);
  const [sort, setSort] = usePersisted("chatvault.sort", "recent");
  const [scope, setScope] = usePersisted("chatvault.scope", "all");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [headerOpen, setHeaderOpen] = usePersisted("chatvault.headerOpen", true);
  const [pinnedOpen, setPinnedOpen] = usePersisted("chatvault.sec.pinned", true);
  const [recentOpen, setRecentOpen] = usePersisted("chatvault.sec.recent", true);
  const [dark, setDark] = useState(() => localStorage.getItem("theme") !== "light");
  const { pins, names, togglePin, rename } = useChatMeta();

  const [overview, setOverview] = useState<Record<Provider, Overview | null>>({ claude: null, codex: null });
  const [accountInfo, setAccountInfo] = useState<AccountInfo[]>([]);
  const account = accounts[provider] ?? "all";
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Chat[]>([]);
  const [pinned, setPinned] = useState<Chat[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingList, setLoadingList] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hits, setHits] = useState<Record<string, string> | null>(null);
  const [searching, setSearching] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [indexing, setIndexing] = useState<IndexProg | null>(null);
  const [selected, setSelected] = useState<Chat | null>(null);
  const [page, setPage] = useState<MsgPage | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [renaming, setRenaming] = useState<Chat | null>(null);
  const [deleting, setDeleting] = useState<Chat | null>(null);
  const [organize, setOrganize] = usePersisted("chatvault.organize", "list");
  const [closedProjects, setClosedProjects] = usePersisted<string[]>("chatvault.closedProjects", []);

  const say = useCallback((m: string) => sonner(m), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const named = useCallback((c: Chat): Chat => (names[chatKey(c)] ? { ...c, title: names[chatKey(c)] } : c), [names]);
  const pinSet = useMemo(() => new Set(pins), [pins]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);
  useEffect(() => {
    const t = window.setTimeout(() => setQ(query.trim()), 250);
    return () => window.clearTimeout(t);
  }, [query]);

  // Scan the disk (only new and changed chats are read), then reload what is on screen.
  const rescan = useCallback(async () => {
    if (!isTauri) return;
    setIndexing({ phase: "Scanning", done: 0, total: 0 });
    try {
      const a = await invoke<AccountInfo[]>("account_info");
      setAccountNames(a);
      setAccountInfo(a);
      await invoke("refresh_index");
    } catch (e) {
      setError(String(e));
    } finally {
      setIndexing(null);
      setReloadKey((k) => k + 1);
    }
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    const un = listen<IndexProg>("index-progress", (e) => setIndexing(e.payload.phase === "Done" ? null : e.payload));
    void (async () => {
      if (localStorage.getItem(AUTO_SYNC_KEY) === "1") await invoke("sync_chats").catch(() => {});
      await rescan();
    })();
    const stopUpdates = startAutoUpdate();
    return () => {
      void un.then((f) => f());
      stopUpdates();
    };
  }, [rescan]);

  useEffect(() => {
    if (!isTauri) return;
    (["claude", "codex"] as Provider[]).forEach((p) =>
      invoke<Overview>("provider_overview", { provider: p })
        .then((o) => setOverview((s) => ({ ...s, [p]: o })))
        .catch(() => {}),
    );
  }, [reloadKey]);

  // Pinned chats of the current tool.
  useEffect(() => {
    if (!isTauri) return;
    const ids = pins.filter((k) => k.startsWith(`${provider}:`)).map((k) => k.slice(provider.length + 1));
    if (!ids.length) {
      setPinned([]);
      return;
    }
    invoke<Chat[]>("chats_by_ids", { provider, ids }).then(setPinned).catch(() => {});
  }, [pins, provider, reloadKey]);

  // First page of the list whenever the tool, account, search or index changes.
  useEffect(() => {
    if (!isTauri) return;
    let stale = false;
    setLoadingList(true);
    setHits(null);
    invoke<{ items: Chat[]; total: number }>("query_chats", { provider, account, q, offset: 0, limit: PAGE_SIZE, sort, scope })
      .then((r) => {
        if (stale) return;
        setItems(r.items);
        setTotal(r.total);
        setError(null);
      })
      .catch((e) => !stale && setError(String(e)))
      .finally(() => !stale && setLoadingList(false));
    return () => {
      stale = true;
    };
  }, [provider, account, q, sort, scope, reloadKey]);

  const loadingMore = useRef(false);
  const loadMore = useCallback(async () => {
    if (loadingMore.current || hits) return;
    loadingMore.current = true;
    try {
      const r = await invoke<{ items: Chat[]; total: number }>("query_chats", { provider, account, q, offset: items.length, limit: PAGE_SIZE, sort, scope });
      setItems((cur) => [...cur, ...r.items]);
      setTotal(r.total);
    } finally {
      loadingMore.current = false;
    }
  }, [provider, account, q, sort, scope, items.length, hits]);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const hasMore = !hits && items.length < total;
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    let timer: number | undefined;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && timer === undefined) {
        timer = window.setTimeout(() => {
          timer = undefined;
          void loadMore();
        }, 250);
      }
    });
    io.observe(el);
    return () => {
      io.disconnect();
      window.clearTimeout(timer);
    };
  }, [hasMore, loadMore, items.length, recentOpen]);

  const runDeepSearch = async () => {
    if (query.trim().length < 2) return;
    setSearching(true);
    try {
      const res = await invoke<Hit[]>("deep_search", { provider, query });
      const found = await invoke<Chat[]>("chats_by_ids", { provider, ids: res.map((h) => h.id) });
      setHits(Object.fromEntries(res.map((h) => [h.id, h.snippet])));
      setItems(found);
      setTotal(found.length);
    } catch (e) {
      say(String(e));
    } finally {
      setSearching(false);
    }
  };

  const open = useCallback(
    (chat: Chat) => {
      setSelected(chat);
      setPage(null);
      invoke<MsgPage>("read_chat_page", { provider: chat.provider, path: chat.path, before: null, limit: MSG_PAGE })
        .then(setPage)
        .catch((e) => {
          setPage({ messages: [], total: 0, start: 0 });
          say(String(e));
        });
    },
    [say],
  );

  const loadEarlier = async () => {
    if (!selected || !page || page.start === 0) return;
    setLoadingEarlier(true);
    try {
      const r = await invoke<MsgPage>("read_chat_page", { provider: selected.provider, path: selected.path, before: page.start, limit: MSG_PAGE });
      setPage({ messages: [...r.messages, ...page.messages], total: r.total, start: r.start });
    } catch (e) {
      say(String(e));
    } finally {
      setLoadingEarlier(false);
    }
  };
  const loadAll = async () => {
    if (!selected || !page) return;
    let cur = page;
    while (cur.start > 0) {
      const r = await invoke<MsgPage>("read_chat_page", { provider: selected.provider, path: selected.path, before: cur.start, limit: 2000 });
      cur = { messages: [...r.messages, ...cur.messages], total: r.total, start: r.start };
      setPage(cur);
    }
  };

  const switchProvider = (p: Provider) => {
    if (p === provider) return;
    setProvider(p);
    setQuery("");
    setSelected(null);
  };

  const tag = (id: string) => {
    const a = accountInfo.find((x) => x.id === id);
    const parts = [a?.desktopCurrent && "Desktop", a?.cliCurrent && "CLI"].filter(Boolean);
    return parts.length ? ` · ${parts.join(" + ")}` : "";
  };
  const accountList = overview[provider]?.accounts ?? [];
  const accountItems = useMemo(
    () => ({
      all: `All accounts · ${(overview[provider]?.total ?? 0).toLocaleString()}`,
      ...Object.fromEntries(accountList.map((a) => [a.id, `${accountLabel(a.id)} · ${a.count.toLocaleString()}${provider === "claude" ? tag(a.id) : ""}`])),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accountList, overview, provider, accountInfo],
  );

  const lq = q.toLowerCase();
  const pinnedShown = pinned.filter((c) => !lq || named(c).title.toLowerCase().includes(lq) || c.project.toLowerCase().includes(lq));
  const recent = items.filter((c) => !pinSet.has(chatKey(c)));
  const msgs: Msg[] | null = page?.messages ?? null;

  const extras = (c: Chat): ChatAction[] => orderChat([
    { id: "view", label: "Open in ChatVault", hint: "Reads this chat here.", icon: Eye, group: "Chat", run: async () => open(c) },
    {
      id: "pin",
      label: pinSet.has(chatKey(c)) ? "Unpin" : "Pin to top",
      hint: "Pinned chats stay at the top of the list.",
      icon: pinSet.has(chatKey(c)) ? PinOff : Pin,
      group: "Chat",
      run: async () => togglePin(chatKey(c)),
    },
    {
      id: "delete",
      label: "Delete chat",
      hint: "Moves the chat file to the Recycle Bin.",
      icon: Trash2,
      group: "Chat",
      danger: true,
      run: async () => setDeleting(c),
    },
    { id: "rename", label: "Rename", hint: "Give this chat your own name. The original is not changed.", icon: Pencil, group: "Chat", run: async () => setRenaming(c) },
  ]);

  const row = (c: Chat) => (
    <ChatRow
      key={chatKey(c)}
      chat={named(c)}
      selected={selected?.id === c.id && selected.provider === c.provider}
      pinned={pinSet.has(chatKey(c))}
      hit={hits?.[c.id]}
      msgs={selected?.id === c.id ? msgs : null}
      extras={extras(c)}
      onOpen={() => open(c)}
      toast={say}
    />
  );

  const cmeta = `${((overview.claude?.total ?? 0) + (overview.codex?.total ?? 0)).toLocaleString()} chats on this PC`;

  return (
    <TooltipProvider delay={200}>
      <div className="flex h-screen bg-background text-foreground">
        {/* Sidebar */}
        <aside className="flex w-[360px] shrink-0 flex-col border-r">
          <button
            onClick={() => setSelected(null)}
            className="flex items-center gap-2 p-3 text-left transition hover:bg-muted/60"
            title="Back to the overview"
          >
            <div className="flex size-8 items-center justify-center rounded-lg bg-muted">
              <MessagesSquare className="size-4 text-muted-foreground" strokeWidth={1.5} />
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="text-base font-medium leading-tight">ChatVault</h1>
              <p className="truncate text-xs text-muted-foreground">
                {indexing ? (indexing.total ? `Indexing ${indexing.done.toLocaleString()} of ${indexing.total.toLocaleString()}` : "Scanning this PC…") : cmeta}
              </p>
            </div>
          </button>

          <div className="space-y-2 px-3 pb-2">
            <Tabs value={provider} onValueChange={(v) => switchProvider(v as Provider)}>
              <TabsList className="grid w-full grid-cols-2">
                {(["claude", "codex"] as Provider[]).map((p) => (
                  <TabsTrigger key={p} value={p} className="gap-1.5">
                    <ProviderLogo provider={p} className="size-4" />
                    {p === "claude" ? "Claude" : "Codex"}
                    <span className="text-xs text-muted-foreground">{overview[p] ? overview[p]!.total.toLocaleString() : "…"}</span>
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
              <Input
                className="h-9 pl-8"
                placeholder="Filter by title, or press Enter to search inside chats"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && runDeepSearch()}
              />
            </div>
            <Select value={account} onValueChange={(v) => v && setAccounts((a) => ({ ...a, [provider]: v }))} items={accountItems}>
              <SelectTrigger className="h-9 w-full">
                <Users className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(accountItems).map(([id, label]) => (
                  <SelectItem key={id} value={id}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {searching && <p className="text-xs text-muted-foreground">Searching inside every chat…</p>}
            {hits && !searching && (
              <p className="text-xs text-muted-foreground">
                {Object.keys(hits).length} chats contain “{query}”.{" "}
                <button className="underline" onClick={() => setReloadKey((k) => k + 1)}>
                  Clear
                </button>
              </p>
            )}
          </div>
          <Separator />

          <ScrollArea className="min-h-0 flex-1">
            <div className="p-1.5 pr-3.5">
              {pinnedShown.length > 0 && (
                <Section title="Pinned" count={pinnedShown.length} open={pinnedOpen} onOpenChange={setPinnedOpen}>
                  {pinnedShown.map(row)}
                </Section>
              )}
              <Section
                title="Recents"
                count={hits ? items.length : total}
                open={recentOpen}
                onOpenChange={setRecentOpen}
                action={
                  <FiltersMenu
                    sort={sort}
                    scope={scope}
                    organize={organize}
                    onSort={setSort}
                    onScope={setScope}
                    onOrganize={setOrganize}
                    onReset={() => {
                      setSort("recent");
                      setScope("all");
                      setOrganize("list");
                    }}
                  />
                }
              >
                {error && <p className="p-3 text-sm text-destructive">{error}</p>}
                {(loadingList || !!indexing) && items.length === 0 && <SidebarSkeleton rows={8} />}
                {!loadingList && !indexing && !error && recent.length === 0 && (
                  <div className="flex flex-col items-center gap-2 p-8 text-center">
                    <Search className="size-8 text-muted-foreground" strokeWidth={1.25} />
                    <p className="text-sm font-medium">No Chats Found</p>
                    <p className="text-xs text-muted-foreground">Try a different word or account.</p>
                  </div>
                )}
                {organize === "project"
                  ? groupByProject(recent).map(([project, list]) => {
                      const isOpen = !closedProjects.includes(project);
                      return (
                        <Collapsible
                          key={project}
                          open={isOpen}
                          onOpenChange={(o) => setClosedProjects((c) => (o ? c.filter((x) => x !== project) : [...c, project]))}
                          className="pt-1"
                        >
                          <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground">
                            <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", isOpen && "rotate-90")} />
                            <FolderOpen className="size-3.5 shrink-0" strokeWidth={1.5} />
                            <span className="min-w-0 flex-1 truncate text-left">{project}</span>
                            <span>{list.length}</span>
                          </CollapsibleTrigger>
                          <CollapsibleContent className="space-y-0.5">{list.map(row)}</CollapsibleContent>
                        </Collapsible>
                      );
                    })
                  : recent.map(row)}
                {hasMore && (
                  <div ref={sentinelRef}>
                    <SidebarSkeleton rows={3} />
                  </div>
                )}
              </Section>
            </div>
          </ScrollArea>
        </aside>

        {/* Content */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
            <p className="min-w-0 flex-1 truncate text-sm font-medium">{selected ? named(selected).title : "Overview"}</p>
            <Tip label="Search chats and actions (Ctrl+K)">
              <Button variant="outline" size="sm" className="text-muted-foreground" onClick={() => setPaletteOpen(true)}>
                <Search className="size-4" /> Search
                <kbd className="ml-1 rounded border bg-muted px-1 text-[10px]">Ctrl K</kbd>
              </Button>
            </Tip>
            <Tip label="Copy every Claude and Codex chat to your Documents folder, or restore them.">
              <Button variant="outline" size="sm" onClick={() => setSyncOpen(true)}>
                <DatabaseBackup className="size-4" /> Sync &amp; backup
              </Button>
            </Tip>
            <Tip label="Scan this PC for new chats.">
              <Button variant="ghost" size="icon" onClick={rescan} aria-label="Refresh" disabled={!!indexing}>
                <RefreshCw className={cn("size-4", indexing && "animate-spin")} />
              </Button>
            </Tip>
            <Tip label={dark ? "Switch to light theme" : "Switch to dark theme"}>
              <Button variant="ghost" size="icon" onClick={() => setDark((d) => !d)} aria-label="Toggle theme">
                {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
              </Button>
            </Tip>
          </div>

          {!selected ? (
            <OverviewPage
              overview={overview}
              accountCount={new Set([...(overview.claude?.accounts ?? []), ...(overview.codex?.accounts ?? [])].map((a) => a.id)).size}
              reloadKey={reloadKey}
              titleOf={(c) => named(c).title}
              onOpenChat={(c) => {
                if (c.provider !== provider) setProvider(c.provider);
                open(c);
              }}
              onSync={() => setSyncOpen(true)}
              onSearch={() => setPaletteOpen(true)}
            />
          ) : (
            <ChatView
              chat={named(selected)}
              page={page}
              loadingEarlier={loadingEarlier}
              onLoadEarlier={loadEarlier}
              onLoadAll={loadAll}
              showSteps={showSteps}
              onToggleSteps={() => setShowSteps((s) => !s)}
              headerOpen={headerOpen}
              onToggleHeader={() => setHeaderOpen((o) => !o)}
              pinned={pinSet.has(chatKey(selected))}
              onTogglePin={() => togglePin(chatKey(selected))}
              onRename={() => setRenaming(selected)}
              onDelete={() => setDeleting(selected)}
              toast={say}
            />
          )}
        </main>

        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          provider={provider}
          pinned={pinned}
          titleOf={(c) => named(c).title}
          onOpenChat={(c) => {
            if (c.provider !== provider) setProvider(c.provider);
            open(c);
          }}
          actions={[
            { id: "overview", label: "Go to the overview", icon: <LayoutDashboard className="size-4" />, run: () => setSelected(null) },
            { id: "claude", label: "Show Claude chats", icon: <ProviderLogo provider="claude" className="size-4" />, run: () => switchProvider("claude") },
            { id: "codex", label: "Show Codex chats", icon: <ProviderLogo provider="codex" className="size-4" />, run: () => switchProvider("codex") },
            { id: "sync", label: "Sync & backup", icon: <DatabaseBackup className="size-4" />, run: () => setSyncOpen(true) },
            { id: "refresh", label: "Scan this PC for new chats", icon: <RefreshCw className="size-4" />, run: () => void rescan() },
            { id: "theme", label: dark ? "Switch to the light theme" : "Switch to the dark theme", icon: dark ? <Sun className="size-4" /> : <Moon className="size-4" />, run: () => setDark((d) => !d) },
          ]}
        />
        <SyncDialog open={syncOpen} onOpenChange={setSyncOpen} onChanged={rescan} toast={say} />
        <DeleteDialog
          chat={deleting}
          onClose={() => setDeleting(null)}
          onConfirm={async (c) => {
            await invoke("delete_chat", { path: c.path });
            if (selected && selected.id === c.id && selected.provider === c.provider) setSelected(null);
            setDeleting(null);
            say("Moved to the Recycle Bin");
            setReloadKey((n) => n + 1);
          }}
        />
        <RenameDialog
          chat={renaming}
          current={renaming ? (names[chatKey(renaming)] ?? "") : ""}
          onClose={() => setRenaming(null)}
          onSave={(name) => {
            if (renaming) rename(chatKey(renaming), name);
            setRenaming(null);
          }}
        />
        <Toaster key={String(dark)} position="bottom-right" />
      </div>
    </TooltipProvider>
  );
}

const groupByProject = (list: Chat[]) => {
  const map = new Map<string, Chat[]>();
  list.forEach((c) => map.set(c.project, [...(map.get(c.project) ?? []), c]));
  return [...map.entries()];
};

const orderChat = (list: ChatAction[]) => [...list.filter((a) => !a.danger), ...list.filter((a) => a.danger)];

function Section({ title, count, open, onOpenChange, action, children }: { title: string; count: number; open: boolean; onOpenChange: (o: boolean) => void; action?: ReactNode; children: ReactNode }) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="mb-1">
      <div className="flex items-center gap-1">
        <CollapsibleTrigger className="flex flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground">
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
          {title}
          <span className="rounded-full bg-muted px-1.5 text-[10px] font-normal text-muted-foreground">{count.toLocaleString()}</span>
        </CollapsibleTrigger>
        {action}
      </div>
      <CollapsibleContent className="space-y-0.5">{children}</CollapsibleContent>
    </Collapsible>
  );
}

const SORTS: Record<string, string> = { recent: "Most recent", oldest: "Oldest first", title: "Title A to Z", size: "Largest first" };
const SCOPES: Record<string, string> = { all: "All", live: "On this PC", backup: "Backup only", archived: "Archived" };

function FiltersMenu({ sort, scope, organize, onSort, onScope, onOrganize, onReset }: { sort: string; scope: string; organize: string; onSort: (s: string) => void; onScope: (s: string) => void; onOrganize: (s: string) => void; onReset: () => void }) {
  const applied = (sort !== "recent" ? 1 : 0) + (scope !== "all" ? 1 : 0);
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="Filters" className="relative size-7 shrink-0 text-muted-foreground" />}>
              <ListFilter className="size-4" />
              {applied > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex size-3.5 items-center justify-center rounded-full bg-primary text-[9px] text-primary-foreground">{applied}</span>
              )}
            </DropdownMenuTrigger>
          }
        />
        <TooltipContent>Filters</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <LayoutDashboard className="size-4" strokeWidth={1.5} /> Organize sidebar
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-44">
            <DropdownMenuRadioGroup value={organize} onValueChange={onOrganize}>
              <DropdownMenuRadioItem value="project">
                <FolderOpen className="size-4" strokeWidth={1.5} /> By project
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="list">
                <ListFilter className="size-4" strokeWidth={1.5} /> In one list
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <ArrowUpDown className="size-4" strokeWidth={1.5} /> Sort chats by
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-44">
            <DropdownMenuRadioGroup value={sort} onValueChange={onSort}>
              {Object.entries(SORTS).map(([k, label]) => (
                <DropdownMenuRadioItem key={k} value={k}>
                  {label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Eye className="size-4" strokeWidth={1.5} /> Show
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-44">
            <DropdownMenuRadioGroup value={scope} onValueChange={onScope}>
              {Object.entries(SCOPES).map(([k, label]) => (
                <DropdownMenuRadioItem key={k} value={k}>
                  {label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={applied === 0 && organize === "list"} onClick={onReset}>
          <RotateCcw className="size-4" strokeWidth={1.5} /> Reset
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const ChatRow = memo(function ChatRow({
  chat,
  selected,
  pinned,
  hit,
  msgs,
  extras,
  onOpen,
  toast,
}: {
  chat: Chat;
  selected: boolean;
  pinned: boolean;
  hit?: string;
  msgs: Msg[] | null;
  extras: ChatAction[];
  onOpen: () => void;
  toast: (m: string) => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
      className={cn("group w-full cursor-pointer rounded-lg border border-transparent px-2.5 py-2 text-left transition hover:bg-muted", selected && "border-border bg-muted")}
    >
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted group-hover:bg-background">
          <ProviderLogo provider={chat.provider} className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{chat.title}</span>
            {pinned && <Pin className="size-3 shrink-0 text-muted-foreground" />}
            {(chat.archived || chat.backup) && <Archive className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.5} />}
            <ChatMenu chat={chat} toast={toast} msgs={msgs} extras={extras} />
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="truncate">{chat.project}</span>
            <span>·</span>
            <span className="shrink-0">{fmtDate(chat.lastMs)}</span>
          </div>
          {hit && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{hit}</p>}
        </div>
      </div>
    </div>
  );
});

function Tip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children as ReactElement} />
      <TooltipContent className="max-w-xs">{label}</TooltipContent>
    </Tooltip>
  );
}

function DeleteDialog({ chat, onClose, onConfirm }: { chat: Chat | null; onClose: () => void; onConfirm: (c: Chat) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const tool = chat?.provider === "codex" ? "Codex" : "Claude Code";
  return (
    <AlertDialog open={!!chat} onOpenChange={(o) => !o && !busy && onClose()}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
              <Trash2 className="size-4 text-destructive" strokeWidth={1.5} />
            </div>
            <div className="min-w-0 space-y-1">
              <AlertDialogTitle className="text-base font-medium">Delete this chat?</AlertDialogTitle>
              <AlertDialogDescription>
                “{chat?.title}” moves to the Recycle Bin and disappears from {tool}. You can restore it from the Recycle Bin.
                {chat?.backup ? " This is a backup copy, so nothing else is removed." : " A copy in your backup folder is kept."}
              </AlertDialogDescription>
            </div>
          </div>
        </AlertDialogHeader>
        <AlertDialogFooter className="grid grid-cols-2 gap-2 sm:flex">
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy}
            onClick={async (e) => {
              e.preventDefault();
              if (!chat) return;
              setBusy(true);
              try {
                await onConfirm(chat);
              } catch (err) {
                sonner(String(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />} Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function RenameDialog({ chat, current, onClose, onSave }: { chat: Chat | null; current: string; onClose: () => void; onSave: (name: string) => void }) {
  const [value, setValue] = useState("");
  useEffect(() => setValue(current || chat?.title || ""), [chat, current]);
  return (
    <Dialog open={!!chat} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
              <Pencil className="size-4 text-muted-foreground" strokeWidth={1.5} />
            </div>
            <div className="min-w-0">
              <DialogTitle className="text-base font-medium">Rename chat</DialogTitle>
              <DialogDescription>Only ChatVault shows this name. The original chat is not changed.</DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSave(value);
          }}
          className="space-y-4"
        >
          <Input autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder="Chat name" maxLength={120} />
          <DialogFooter className="grid grid-cols-3 gap-2 sm:flex">
            <Button type="button" variant="ghost" disabled={!current} onClick={() => onSave("")}>
              Reset
            </Button>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const QUICK = ["continue-claude", "continue-codex", "open", "reveal", "copy-md"];

function ChatMenu({ chat, toast, msgs, extras }: { chat: Chat; toast: (m: string) => void; msgs: Msg[] | null; extras: ChatAction[] }) {
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const actions = [...extras, ...chatActions(chat, toast, msgs).filter((a) => QUICK.includes(a.id))];
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
  const groups = ["Chat", "Continue", "Open", "Copy"] as const;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label="Chat actions"
            className={cn(
              "-my-1 size-7 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100",
              open && "opacity-100",
            )}
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
              {g !== "Chat" && <p className="px-2 pb-0.5 pt-1.5 text-xs text-muted-foreground">{g}</p>}
              {items.map((a) => {
                const Icon = a.icon;
                return (
                  <button
                    key={a.id}
                    title={a.hint}
                    disabled={busyId !== null}
                    className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-60", a.danger && "text-destructive hover:bg-destructive/10")}
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
                    {busyId === a.id ? <Loader2 className="size-4 animate-spin" /> : <Icon className={cn("size-4", a.danger ? "text-destructive" : "text-muted-foreground")} strokeWidth={1.5} />}
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
