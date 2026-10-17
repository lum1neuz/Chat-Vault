import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  DatabaseBackup,
  Eye,
  FolderOpen,
  Trash2,
  ArrowUpDown,
  ChevronsDownUp,
  ChevronsUpDown,
  ListFilter,
  PanelLeft,
  RotateCcw,
  LayoutDashboard,
  Loader2,
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AppToaster, notify } from "@/toast";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { AppLogo, ProviderLogo } from "@/claude-logo";
import { PROVIDERS, PROVIDER_NAME, PROVIDER_SHORT, accountLabel, chatActions, fmtDate, setAccountNames, type AccountInfo, type Chat, type ChatAction, type Msg, type MsgPage, type Provider } from "@/chat-actions";
import { ChatView } from "@/chat-view";
import { FadedScroll } from "@/faded-scroll";
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
import { Splash } from "@/splash";
import { TitleBar } from "@/titlebar";
import { AUTO_SYNC_KEY, SyncDialog } from "@/sync-dialog";
import { chatKey, useChatMeta, usePersisted } from "@/store";
import { startAutoUpdate } from "@/updater";

const PAGE_SIZE = 20;
const MSG_PAGE = 80;

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
  const [sidebarOpen, setSidebarOpen] = usePersisted("chatvault.sidebar", true);
  const [headerOpen, setHeaderOpen] = usePersisted("chatvault.headerOpen", true);
  const [pinnedOpen, setPinnedOpen] = usePersisted("chatvault.sec.pinned", true);
  const [recentOpen, setRecentOpen] = usePersisted("chatvault.sec.recent", true);
  const [dark, setDark] = useState(() => localStorage.getItem("theme") !== "light");
  const { pins, names, togglePin, rename } = useChatMeta();

  const [overview, setOverview] = useState<Record<Provider, Overview | null>>({ claude: null, codex: null, cursor: null });
  const [accountInfo, setAccountInfo] = useState<AccountInfo[]>([]);
  const account = accounts[provider] ?? "all";
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Chat[]>([]);
  const [pinned, setPinned] = useState<Chat[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingList, setLoadingList] = useState(true);
  // The start screen stays for at least a moment, then fades once the first list is in.
  const [splash, setSplash] = useState<"on" | "leaving" | "off">("on");
  const bootAt = useRef(Date.now());
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
  // Expand/collapse-all sets a mode; single clicks are exceptions to it, so projects that load later follow the mode too.
  const [projectsMode, setProjectsMode] = usePersisted<"open" | "closed">("chatvault.projectsMode", "open");
  const [projectExceptions, setProjectExceptions] = usePersisted<string[]>("chatvault.projectExceptions", []);
  const projectOpen = useCallback((n: string) => (projectsMode === "open") !== projectExceptions.includes(n), [projectsMode, projectExceptions]);

  const say = useCallback((m: string) => void notify(m), []);
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
      // Backing up is on unless you turned it off: once at start, then every 10 minutes while ChatVault is open.
      if (localStorage.getItem(AUTO_SYNC_KEY) !== "0") await invoke("sync_chats").catch(() => {});
      await rescan();
    })();
    const every = window.setInterval(() => {
      if (localStorage.getItem(AUTO_SYNC_KEY) !== "0") void invoke("sync_chats").then(() => rescan()).catch(() => {});
    }, 10 * 60 * 1000);
    const stopUpdates = startAutoUpdate();
    const offSync = listen("tray-sync", () => setSyncOpen(true));
    const offScan = listen("tray-rescan", () => void rescan());
    return () => {
      void un.then((f) => f());
      void offSync.then((f) => f());
      void offScan.then((f) => f());
      window.clearInterval(every);
      stopUpdates();
    };
  }, [rescan]);

  useEffect(() => {
    if (!isTauri) return;
    PROVIDERS.forEach((p) =>
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

  useEffect(() => {
    if (splash !== "on" || (isTauri && (loadingList || indexing))) return;
    const t = window.setTimeout(() => {
      setSplash("leaving");
      window.setTimeout(() => setSplash("off"), 320);
    }, Math.max(0, 900 - (Date.now() - bootAt.current)));
    return () => window.clearTimeout(t);
  }, [splash, loadingList, indexing]);

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

  const openId = useRef(0);
  const [outline, setOutline] = useState<{ ts: string; text: string }[] | null>(null);
  const open = useCallback(
    (chat: Chat) => {
      const id = ++openId.current;
      setSelected(chat);
      setPage(null);
      setOutline(null);
      // A light outline of the whole chat for the timeline, built in the background; only a few short lines come back.
      invoke<{ ts: string; text: string }[]>("chat_outline", { provider: chat.provider, path: chat.path })
        .then((o) => {
          if (openId.current === id) setOutline(o);
        })
        .catch(() => {});
      // The newest messages come first, read from the end of the file, so the chat is readable at once.
      invoke<Msg[]>("read_chat_tail", { provider: chat.provider, path: chat.path, limit: MSG_PAGE })
        .then((messages) => {
          if (openId.current === id) setPage((cur) => cur ?? { messages, total: messages.length, start: 0, partial: true });
        })
        .catch(() => {});
      // The real total follows; earlier messages are only read as you scroll up toward them.
      invoke<MsgPage>("read_chat_page", { provider: chat.provider, path: chat.path, before: null, limit: MSG_PAGE })
        .then((r) => {
          if (openId.current === id) setPage(r);
        })
        .catch((e) => {
          if (openId.current !== id) return;
          setPage((cur) => (cur ? { ...cur, partial: false } : { messages: [], total: 0, start: 0 }));
          say(String(e));
        });
    },
    [say],
  );

  // Keep the open chat live: when its file grows, only the new messages are read and added at the bottom.
  // A fork is a new file next to the original: index it, name it, and open it, all without a terminal.
  useEffect(() => {
    const onFork = async (e: Event) => {
      const d = (e as CustomEvent<{ from: Chat; id: string; path: string }>).detail;
      try {
        await invoke("refresh_index");
        setReloadKey((k) => k + 1);
        const r = await invoke<{ items: Chat[] }>("query_chats", { provider: d.from.provider, account: "all", q: "", offset: 0, limit: 40, sort: "recent", scope: "all" });
        const made = r.items.find((c) => c.id === d.id);
        if (made) {
          rename(chatKey(made), `${names[chatKey(d.from)] || d.from.title} (fork)`);
          setProvider(made.provider);
          open(made);
        }
      } catch (err) {
        say(String(err));
      }
    };
    window.addEventListener("chatvault:forked", onFork);
    return () => window.removeEventListener("chatvault:forked", onFork);
  }, [rename, names, open, say]);

  // Chats an agent is writing to right now (their file changed in the last 20 seconds) get a green dot in the list.
  const [liveKeys, setLiveKeys] = useState<Set<string>>(new Set());
  const listed = useRef<Chat[]>([]);
  listed.current = [...pinned, ...items];
  useEffect(() => {
    let busy = false;
    const tick = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const seen = new Map<string, Chat>();
        listed.current.forEach((c) => c.provider !== "cursor" && seen.set(chatKey(c), c));
        const chats = [...seen.values()];
        const ms = await invoke<number[]>("chat_stamps", { items: chats.map((c) => [c.provider, c.path]) });
        const now = Date.now();
        const next = new Set<string>();
        chats.forEach((c, i) => ms[i] && now - ms[i] < 20000 && next.add(chatKey(c)));
        setLiveKeys((cur) => (cur.size === next.size && [...next].every((k) => cur.has(k)) ? cur : next));
      } catch {
        /* try again next time */
      } finally {
        busy = false;
      }
    };
    void tick();
    const id = window.setInterval(tick, 3000);
    return () => window.clearInterval(id);
  }, []);

  // Every tool: new conversations and new messages show up on their own. A new file is picked up at once;
  // changes inside existing chats are folded in at most every 15 seconds.
  // Refreshes the list in place: keeps as many rows as are already shown, so the sidebar does not jump back to the top.
  const listArgs = useRef({ provider, account, q, sort, scope, count: 0 });
  listArgs.current = { provider, account, q, sort, scope, count: items.length };
  const quietReload = useCallback(async () => {
    const l = listArgs.current;
    const r = await invoke<{ items: Chat[]; total: number }>("query_chats", { provider: l.provider, account: l.account, q: l.q, offset: 0, limit: Math.min(300, Math.max(PAGE_SIZE, l.count)), sort: l.sort, scope: l.scope });
    setItems(r.items);
    setTotal(r.total);
  }, []);
  const cursorFp = useRef(0);
  const cursorChanged = useRef(0);
  const filesFp = useRef<[number, number] | null>(null);
  const lastRefresh = useRef(0);
  useEffect(() => {
    if (!isTauri) return;
    let busy = false;
    const id = window.setInterval(async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const [fp, ff] = await Promise.all([invoke<number>("cursor_fingerprint"), invoke<[number, number]>("files_fingerprint")]);
        const cursorMoved = cursorFp.current !== 0 && fp !== cursorFp.current;
        const prev = filesFp.current;
        const fresh = !!prev && ff[0] !== prev[0];
        const grew = !!prev && ff[1] !== prev[1] && Date.now() - lastRefresh.current > 15000;
        cursorFp.current = fp;
        filesFp.current = ff;
        if (cursorMoved) cursorChanged.current = Date.now();
        if (cursorMoved || fresh || grew) {
          lastRefresh.current = Date.now();
          await invoke("refresh_index");
          await quietReload();
          const sel = selRef.current;
          const cur = pageRef.current;
          if (cursorMoved && sel?.provider === "cursor" && cur && !cur.partial) {
            const r = await invoke<MsgPage>("read_chat_page", { provider: "cursor", path: sel.path, before: null, limit: 2000 });
            if (selRef.current?.id === sel.id && r.total !== cur.total) setPage(r);
          }
        }
        if (selRef.current?.provider === "cursor") setLive(Date.now() - cursorChanged.current < 20000);
      } catch {
        /* try again next time */
      } finally {
        busy = false;
      }
    }, 2000);
    return () => window.clearInterval(id);
  }, [quietReload]);

  const stamp = useRef("");
  const [live, setLive] = useState(false);
  const pageRef = useRef(page);
  pageRef.current = page;
  const selRef = useRef(selected);
  selRef.current = selected;
  useEffect(() => {
    stamp.current = "";
    setLive(false);
    const sel = selected;
    if (!sel || sel.provider === "cursor") return;
    let busy = false;
    const id = window.setInterval(async () => {
      const cur = pageRef.current;
      if (busy || !cur || cur.partial || selRef.current?.id !== sel.id) return;
      busy = true;
      try {
        const [size, ms] = await invoke<[number, number]>("chat_stamp", { provider: sel.provider, path: sel.path });
        // Working = the file changed a moment ago, or your message / a tool call is still waiting for the agent to continue.
        const last = cur.messages[cur.messages.length - 1];
        const waiting = !!last && (last.role === "user" || last.kind === "tool");
        const age = Date.now() - ms;
        setLive(age < 20000 || (waiting && age < 120000));
        const st = `${size}:${ms}`;
        if (!stamp.current) {
          stamp.current = st;
          return;
        }
        if (st === stamp.current) return;
        stamp.current = st;
        // Fast path: only the end of the file is read, and what is new is whatever follows the last message already shown.
        const sig = (m: Msg) => `${m.ts}|${m.role}|${m.kind}|${m.text.slice(0, 80)}`;
        const lastShown = cur.messages[cur.messages.length - 1];
        if (lastShown && sel.provider !== "cursor") {
          try {
            const tail = await invoke<Msg[]>("read_chat_tail", { provider: sel.provider, path: sel.path, limit: 60 });
            const at = tail.map(sig).lastIndexOf(sig(lastShown));
            if (at >= 0) {
              const add = tail.slice(at + 1);
              if (selRef.current?.id !== sel.id) return;
              if (add.length) setPage((p) => (p && p.total === cur.total ? { ...p, messages: [...p.messages, ...add], total: p.total + add.length } : p));
              return;
            }
          } catch {
            /* fall back to the full read below */
          }
        }
        let r = await invoke<MsgPage>("read_chat_page", { provider: sel.provider, path: sel.path, before: null, limit: 50 });
        const diff = r.total - cur.total;
        if (diff > 50) r = await invoke<MsgPage>("read_chat_page", { provider: sel.provider, path: sel.path, before: null, limit: Math.min(diff, 2000) });
        if (selRef.current?.id !== sel.id) return;
        if (diff <= 0) {
          if (diff < 0) setPage(r);
          return;
        }
        const add = r.messages.slice(-diff);
        setPage((p) => (p && p.total === cur.total ? { ...p, messages: [...p.messages, ...add], total: r.total } : p));
      } catch {
        /* the file may be mid-write; try again next time */
      } finally {
        busy = false;
      }
    }, 600);
    return () => window.clearInterval(id);
  }, [selected?.id, selected?.provider, selected?.path]);

  const loadEarlier = async () => {
    if (!selected || !page || page.start === 0) return;
    setLoadingEarlier(true);
    try {
      const r = await invoke<MsgPage>("read_chat_page", { provider: selected.provider, path: selected.path, before: page.start, limit: 200 });
      setPage({ messages: [...r.messages, ...page.messages], total: r.total, start: r.start });
    } catch (e) {
      say(String(e));
    } finally {
      setLoadingEarlier(false);
    }
  };
  /** Reads earlier messages until the one sent at `ts` is loaded, so a tick far up the timeline can be opened. */
  const untilBusy = useRef(false);
  const untilWant = useRef<string | null>(null);
  const loadUntil = async (ts: string) => {
    // One quiet load at a time; if you hover a tick further up meanwhile, it carries on to that one.
    if (untilBusy.current) {
      if (!untilWant.current || Date.parse(ts) < Date.parse(untilWant.current)) untilWant.current = ts;
      return;
    }
    const sel = selRef.current;
    if (!sel || !pageRef.current) return;
    untilBusy.current = true;
    let target = Date.parse(ts);
    try {
      for (;;) {
        const first = pageRef.current;
        if (!first) break;
        let cur: MsgPage = first;
        while (cur.start > 0) {
          const oldest = cur.messages.find((m) => m.ts)?.ts;
          if (oldest && Date.parse(oldest) <= target) break;
          const r = await invoke<MsgPage>("read_chat_page", { provider: sel.provider, path: sel.path, before: cur.start, limit: 400 });
          if (selRef.current?.id !== sel.id) return;
          cur = { messages: [...r.messages, ...cur.messages], total: r.total, start: r.start };
          pageRef.current = cur;
          setPage(cur);
        }
        if (untilWant.current && Date.parse(untilWant.current) < target) {
          target = Date.parse(untilWant.current);
          untilWant.current = null;
          continue;
        }
        break;
      }
    } catch (e) {
      say(String(e));
    } finally {
      untilBusy.current = false;
      untilWant.current = null;
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
  const projectNames = useMemo(() => groupByProject(recent).map(([name]) => name), [recent]);
  const allProjectsClosed = projectNames.length > 0 && projectNames.every((n) => !projectOpen(n));
  const msgs: Msg[] | null = page?.messages ?? null;

  const extras = (c: Chat): ChatAction[] => orderChat(([
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
    {
      id: "archive",
      label: c.userArchived ? "Unarchive" : "Archive",
      hint: c.userArchived ? "Moves this chat back to your list." : "Moves this chat out of your list into Archived. Nothing is deleted.",
      icon: c.userArchived ? ArchiveRestore : Archive,
      group: "Chat",
      run: async () => archive(c),
    },
    { id: "rename", label: "Rename", hint: "Give this chat your own name. The original is not changed.", icon: Pencil, group: "Chat", run: async () => setRenaming(c) },
  ] as ChatAction[]).filter((a) => !(a.id === "delete" && c.provider === "cursor")));

  const archive = async (c: Chat) => {
    const to = !c.userArchived;
    try {
      await invoke("set_chat_archived", { provider: c.provider, id: c.id, archived: to });
      say(to ? "Moved to Archived" : "Moved back to your list");
      if (selected?.id === c.id && selected.provider === c.provider) setSelected(to && scope !== "archived" ? { ...c, userArchived: to } : { ...c, userArchived: to });
      await quietReload();
    } catch (e) {
      say(String(e));
    }
  };

  const row = (c: Chat) => (
    <ChatRow
      key={chatKey(c)}
      chat={named(c)}
      selected={selected?.id === c.id && selected.provider === c.provider}
      pinned={pinSet.has(chatKey(c))}
      live={liveKeys.has(chatKey(c))}
      hit={hits?.[c.id]}
      msgs={selected?.id === c.id ? msgs : null}
      extras={extras(c)}
      onOpen={() => open(c)}
      toast={say}
    />
  );


  const controls = (
    <>
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
    </>
  );

  return (
    <TooltipProvider delay={200}>
      <div className="flex h-screen overflow-hidden bg-background text-foreground">
      {splash !== "off" && <Splash leaving={splash === "leaving"} />}
        {/* Sidebar */}
        <aside className={cn("flex shrink-0 flex-col overflow-hidden border-r transition-[width] duration-300 ease-in-out", sidebarOpen ? "w-[320px]" : "w-0 border-r-0")}>
          {sidebarOpen ? (
            <div data-tauri-drag-region className="flex h-14 shrink-0 items-center gap-1 pl-3 pr-14">
              <button
                onClick={() => setSelected(null)}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 p-1 text-left outline-none"
              >
                <AppLogo className="size-7 shrink-0 rounded-lg ring-1 ring-border" />
                <div className="min-w-0">
                  <h1 className="truncate text-base font-medium leading-tight">ChatVault</h1>
                </div>
              </button>
            </div>
          ) : null}
          <div className={cn("flex min-h-0 w-[320px] flex-1 flex-col transition-opacity duration-200", sidebarOpen ? "opacity-100" : "pointer-events-none opacity-0")}>

          <div className="space-y-2 px-3 pb-2">
            <Tabs value={provider} onValueChange={(v) => switchProvider(v as Provider)}>
              <TabsList className="grid w-full grid-cols-3">
                {PROVIDERS.map((p) => (
                  <TabsTrigger key={p} value={p} className="gap-1.5">
                    <ProviderLogo provider={p} className="size-4" />
                    {PROVIDER_SHORT[p]}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
              <Input
                className="h-9 pl-8"
                placeholder="Search chats"
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
              <SelectContent alignItemWithTrigger={false} align="start" sideOffset={6}>
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

          <FadedScroll className="flex-1" fadeTop={false}>
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
                  <div className="flex items-center">
                    {organize === "project" && (
                      <Tip label={allProjectsClosed ? "Expand all projects" : "Collapse all projects"}>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={allProjectsClosed ? "Expand all projects" : "Collapse all projects"}
                          className="size-7 shrink-0 text-muted-foreground"
                          onClick={() => {
                            setProjectsMode(allProjectsClosed ? "open" : "closed");
                            setProjectExceptions([]);
                          }}
                        >
                          {allProjectsClosed ? <ChevronsUpDown className="size-4" /> : <ChevronsDownUp className="size-4" />}
                        </Button>
                      </Tip>
                    )}
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
                  </div>
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
                      const isOpen = projectOpen(project);
                      return (
                        <Collapsible
                          key={project}
                          open={isOpen}
                          onOpenChange={(o) => setProjectExceptions((c) => (o === (projectsMode === "open") ? c.filter((x) => x !== project) : c.includes(project) ? c : [...c, project]))}
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
          </FadedScroll>
          </div>
        </aside>

        {/* Content */}
        <div className="flex min-w-0 flex-1 flex-col">
        <TitleBar title={selected ? `${PROVIDER_NAME[selected.provider]} / ${selected.project}` : undefined} actions={selected ? controls : undefined} sidebarOpen={sidebarOpen} busy={!!indexing} dark={dark} onRefresh={rescan} onTheme={() => setDark((d) => !d)} />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!selected ? (
            <OverviewPage
              actions={controls}
              indexing={indexing}
              userName={accountInfo.find((a) => a.cliCurrent)?.name ?? undefined}
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
              live={live}
              outline={outline}
              onLoadUntil={loadUntil}
              onLoadEarlier={loadEarlier}
              onLoadAll={loadAll}
              showSteps={showSteps}
              onToggleSteps={() => setShowSteps((s) => !s)}
              headerOpen={headerOpen}
              onToggleHeader={() => setHeaderOpen((o) => !o)}
              pinned={pinSet.has(chatKey(selected))}
              onTogglePin={() => togglePin(chatKey(selected))}
              onArchive={() => void archive(selected)}
              onRename={() => setRenaming(selected)}
              onDelete={() => setDeleting(selected)}
              toast={say}
            />
          )}
        </main>
        </div>

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
        <div className={cn("fixed top-3 z-30 transition-[left] duration-300 ease-in-out", sidebarOpen ? "left-[272px]" : "left-3", splash !== "off" && "hidden")}>
          <Tip label={sidebarOpen ? "Hide the sidebar" : "Show the sidebar"}>
            <Button variant="ghost" size="icon" className="text-muted-foreground" aria-label={sidebarOpen ? "Hide the sidebar" : "Show the sidebar"} onClick={() => setSidebarOpen((o) => !o)}>
              <PanelLeft className="size-4" />
            </Button>
          </Tip>
        </div>
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
        <AppToaster />
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
  live,
  hit,
  msgs,
  extras,
  onOpen,
  toast,
}: {
  chat: Chat;
  selected: boolean;
  pinned: boolean;
  live?: boolean;
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
      className={cn("group w-full cursor-pointer rounded-lg border border-transparent px-2.5 py-2 text-left transition hover:bg-muted/50 dark:hover:bg-white/5", selected && "border-border bg-muted hover:bg-muted dark:border-white/15 dark:bg-white/10 dark:hover:bg-white/10")}
    >
      <div className="flex items-start gap-2.5">
        <div className={cn("relative mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted group-hover:bg-white dark:group-hover:bg-white/10", selected && "bg-white dark:bg-white/10")}>
          <ProviderLogo provider={chat.provider} className="size-5" />
          {live && (
            <span className="absolute -right-1 -top-1 flex size-2" aria-label="An agent is working in this chat">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex size-2 rounded-full bg-emerald-500 ring-[1.5px] ring-background" />
            </span>
          )}
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
  const tool = chat ? PROVIDER_NAME[chat.provider] : "";
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
                notify(String(err));
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
              <DialogDescription>Only shown in ChatVault.</DialogDescription>
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
          <DialogFooter className="grid grid-cols-2 gap-2 sm:flex">
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

const QUICK = ["continue-claude", "continue-codex", "fork", "folder", "copy-id"];

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
  const groups = ["Chat", "Continue", "Open", "Copy", "Save"] as const;
  const inGroup = (a: ChatAction, g: string) => a.group === g;
  const renderItem = (a: ChatAction) => {
    const Icon = a.icon;
    return (
      <button
        key={a.id}
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
  };
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
      <PopoverContent side="right" align="start" sideOffset={8} className="w-64 gap-0 p-1" onClick={(e) => e.stopPropagation()}>
        {groups.map((g, gi) => {
          const items = actions.filter((a) => inGroup(a, g) && !a.danger);
          if (!items.length) return null;
          return (
            <div key={g}>
              {gi > 0 && <Separator className="my-1" />}
              {g !== "Chat" && <p className="px-2 pb-0.5 pt-1.5 text-xs text-muted-foreground">{g}</p>}
              {items.map(renderItem)}
            </div>
          );
        })}
        {actions.some((a) => a.danger) && (
          <div>
            <Separator className="my-1" />
            {actions.filter((a) => a.danger).map(renderItem)}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
