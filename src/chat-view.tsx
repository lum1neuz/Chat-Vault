import { ChatImage, GalleryContext, Lightbox } from "@/image-viewer";
import { animateScroll } from "react-scroll";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import {
  Archive,
  ArrowDown,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  Cpu,
  HardDrive,
  MessageSquare,
  Copy,
  FileText,
  ListTree,
  Loader2,
 
  Pencil,
  Pin,
  PinOff,
  Quote,
  Search,
  Trash2,
  User,
  X,
} from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Message, MessageAvatar, MessageContent, MessageHeader } from "@/components/ui/message";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import Lenis from "lenis";
import "lenis/dist/lenis.css";
import { cn } from "@/lib/utils";
import { ProviderLogo } from "@/claude-logo";
import { MessageBody } from "@/message-body";
import { Highlight, textHas } from "@/highlight";
import { PROVIDER_SHORT, chatActions, fmtDate, fmtSize, type Chat, type Msg, type MsgPage, type Provider } from "@/chat-actions";
import { HeaderSkeleton, MessagesSkeleton } from "@/skeletons";
import { PlanBlock, StepItem, SubagentBlock, isAgent, isPlan, mergeResults, stepName, type Item } from "@/steps";

type Props = {
  chat: Chat;
  page: MsgPage | null;
  loadingEarlier: boolean;
  live?: boolean;
  outline?: { ts: string; text: string }[] | null;
  onLoadUntil?: (ts: string) => Promise<void>;
  onLoadEarlier: () => void;
  onLoadAll: () => Promise<void>;
  showSteps: boolean;
  onToggleSteps: () => void;
  headerOpen: boolean;
  onToggleHeader: () => void;
  pinned: boolean;
  onTogglePin: () => void;
  onRename: () => void;
  onDelete: () => void;
  toast: (m: string) => void;
};

function Tip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent className="max-w-xs">{label}</TooltipContent>
    </Tooltip>
  );
}

type Block = { kind: "msg"; i: number; m: Item } | { kind: "plan"; i: number; m: Item } | { kind: "agent"; i: number; m: Item } | { kind: "trace"; i: number; items: { i: number; m: Item }[] };

export function ChatView(p: Props) {
  const { chat, page } = p;
  const [searchOpen, setSearchOpen] = useState(false);
  const [q, setQ] = useState("");
  const [cur, setCur] = useState(0);
  const [showJump, setShowJump] = useState(false);
  const [atTop, setAtTop] = useState(true);
  const [atEnd, setAtEnd] = useState(false);
  const [activeTick, setActiveTick] = useState(0);
  const [loadingAll, setLoadingAll] = useState(false);
  const [viewer, setViewer] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [margin, setMargin] = useState(0);

  const merged = useMemo(() => (page ? mergeResults(page.messages) : []), [page]);
  const shown = useMemo(() => merged.filter((m) => p.showSteps || (m.kind !== "tool" && m.kind !== "reasoning")), [merged, p.showSteps]);
  const viewport = useCallback(() => wrapRef.current?.querySelector<HTMLElement>("[data-slot=scroll-area-viewport]") ?? null, []);

  // Smooth, eased wheel and touch scrolling for the message list.
  const lenisRef = useRef<Lenis | null>(null);
  const ready = page !== null;
  useEffect(() => {
    const el = viewport();
    const content = el?.firstElementChild as HTMLElement | null | undefined;
    if (!el || !content || !ready) return;
    const lenis = new Lenis({ wrapper: el, content, duration: 1, wheelMultiplier: 0.9, touchMultiplier: 1.2, smoothWheel: true });
    lenisRef.current = lenis;
    let id = requestAnimationFrame(function loop(time) {
      lenis.raf(time);
      id = requestAnimationFrame(loop);
    });
    return () => {
      cancelAnimationFrame(id);
      lenis.destroy();
      lenisRef.current = null;
    };
  }, [viewport, chat.id, ready]);

  // Consecutive tool steps collapse into one Trace.
  const blocks = useMemo(() => {
    const out: Block[] = [];
    shown.forEach((m, i) => {
      if (isPlan(m)) out.push({ kind: "plan", i, m });
      else if (isAgent(m)) out.push({ kind: "agent", i, m });
      else if (m.kind === "tool" || m.kind === "reasoning") {
        const last = out[out.length - 1];
        if (last && last.kind === "trace") last.items.push({ i, m });
        else out.push({ kind: "trace", i, items: [{ i, m }] });
      } else out.push({ kind: "msg", i, m });
    });
    return out;
  }, [shown]);

  // Stable keys keep measured heights when earlier messages are added above.
  const keys = useMemo(() => {
    const seen = new Map<string, number>();
    const list = blocks.map((b) => {
      const m = b.kind === "trace" ? b.items[0].m : b.m;
      const base = `${b.kind}|${m.ts ?? ""}|${m.role}|${m.text.slice(0, 48)}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      return `${base}|${n}`;
    });
    return list;
  }, [blocks]);
  const blockOf = useMemo(() => {
    const out: number[] = [];
    blocks.forEach((b, bi) => {
      if (b.kind === "trace") b.items.forEach((t) => (out[t.i] = bi));
      else out[b.i] = bi;
    });
    return out;
  }, [blocks]);

  const virt = useVirtualizer({
    count: blocks.length,
    getScrollElement: viewport,
    estimateSize: (i) => (blocks[i]?.kind === "trace" ? 36 : blocks[i]?.kind === "msg" ? 150 : 90),
    overscan: 6,
    scrollMargin: margin,
    getItemKey: (i) => keys[i] ?? i,
    useAnimationFrameWithResizeObserver: true,
  });
  // Keep the message you are reading in the same place when messages are added above it.
  const lastAnchor = useRef<{ key: string; delta: number } | null>(null);
  const pinning = useRef(false);
  useLayoutEffect(() => {
    const a = lastAnchor.current;
    const el = viewport();
    if (a && el && !pinning.current) {
      const idx = keys.indexOf(a.key);
      const off = idx >= 0 ? virt.getOffsetForIndex(idx, "start") : null;
      if (off) {
        const want = off[0] - a.delta;
        if (Math.abs(want - el.scrollTop) > 2) {
          lenisRef.current?.scrollTo(want, { immediate: true, force: true });
          el.scrollTop = want;
        }
      }
    }
  }, [keys, virt, viewport]);
  useLayoutEffect(() => {
    const el = viewport();
    const v0 = virt.getVirtualItems()[0];
    lastAnchor.current = el && v0 ? { key: String(v0.key), delta: v0.start - el.scrollTop } : null;
  });
  // New messages that arrive while you are reading at the bottom are followed; if you scrolled up, your place is kept.
  /** Animated scroll with react-scroll. Lenis steps aside while it runs so the two never fight. */
  const SCROLL_ID = "chatvault-messages";
  const animateTo = useCallback(
    (y: number, ms: number, done?: () => void) => {
      const el = viewport();
      if (!el) return;
      el.id = SCROLL_ID;
      lenisRef.current?.stop();
      animateScroll.scrollTo(Math.max(0, y), { containerId: SCROLL_ID, duration: ms, smooth: "easeInOutCubic" });
      window.setTimeout(() => {
        lenisRef.current?.start();
        done?.();
      }, ms + 40);
    },
    [viewport],
  );
  const jumpNow = useCallback(
    (y: number) => {
      const el = viewport();
      if (!el) return;
      lenisRef.current?.scrollTo(y, { immediate: true, force: true });
      el.scrollTop = y;
    },
    [viewport],
  );

  const nearBottom = useRef(true);
  useEffect(() => {
    if (!nearBottom.current) return;
    const id = requestAnimationFrame(() => {
      const el = viewport();
      if (!el) return;
      animateTo(el.scrollHeight, 600);
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page?.total, p.live]);
  // A chat opens at its latest message. Row heights settle as they are measured and earlier messages load above,
  // so the view stays pinned to the bottom until everything has settled, or until you scroll yourself.
  const partialNow = useRef(false);
  partialNow.current = !!page?.partial;
  useLayoutEffect(() => {
    if (!ready) return;
    const el = viewport();
    if (!el) return;
    let stop = false;
    let lastSH = 0;
    let changed = performance.now();
    pinning.current = true;
    const hardEnd = performance.now() + 30000;
    const cancel = () => {
      stop = true;
      pinning.current = false;
    };
    const evs = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
    evs.forEach((e) => el.addEventListener(e, cancel, { passive: true, once: true }));
    const tick = () => {
      if (stop) return;
      const now = performance.now();
      // Done once the full page is in and the content height has stopped changing.
      if (el.scrollHeight !== lastSH) {
        lastSH = el.scrollHeight;
        changed = now;
      }
      if (!partialNow.current && now - changed > 700) {
        pinning.current = false;
        return;
      }
      if (now > hardEnd) {
        pinning.current = false;
        return;
      }
      el.scrollTop = el.scrollHeight;
      requestAnimationFrame(tick);
    };
    tick();
    return () => {
      stop = true;
      pinning.current = false;
      evs.forEach((e) => el.removeEventListener(e, cancel));
    };
  }, [ready, chat.id, viewport]);
  useLayoutEffect(() => setMargin(listRef.current?.offsetTop ?? 0), [page?.start, ready]);

  /** Scrolls a message into place with the wheel's easing. Rows are measured as they appear, so it settles on the exact spot at the end. */
  const goTo = useCallback(
    (shownIdx: number, align: "start" | "center", instant = false) => {
      const el = viewport();
      const bi = blockOf[shownIdx];
      if (!el || bi === undefined) return;
      const spot = () => {
        const r = virt.getOffsetForIndex(bi, align === "center" ? "center" : "start");
        return Math.max(0, (r ? r[0] : 0) - (align === "center" ? 0 : 16));
      };
      const target = spot();
      if (instant) {
        // Straight there, then re-check as the rows around it are measured.
        jumpNow(target);
        requestAnimationFrame(() => jumpNow(spot()));
        window.setTimeout(() => jumpNow(spot()), 120);
        window.setTimeout(() => jumpNow(spot()), 320);
        return;
      }
      const dist = target - el.scrollTop;
      // A long way off first hops to just short of the spot, then glides in, so it never sweeps through thousands of rows.
      if (Math.abs(dist) > el.clientHeight * 2.5) jumpNow(Math.max(0, target - Math.sign(dist) * el.clientHeight * 1.2));
      const settle = (tries: number) => {
        const t = spot();
        if (Math.abs(t - el.scrollTop) > 6 && tries > 0) animateTo(t, 250, () => settle(tries - 1));
      };
      animateTo(target, 800, () => settle(2));
    },
    [viewport, blockOf, virt, animateTo, jumpNow],
  );

  const images = useMemo(() => shown.filter((m) => m.kind === "image" && typeof m.data === "string").map((m) => m.data as string), [shown]);
  const gallery = useMemo(() => ({ images, open: (src: string) => setViewer(Math.max(0, images.indexOf(src))) }), [images]);
  useEffect(() => setViewer(null), [chat.id]);

  const query = searchOpen ? q.trim() : "";
  const matches = useMemo(() => {
    if (!query) return [] as number[];
    const out: number[] = [];
    shown.forEach((m, i) => {
      if (m.kind !== "image" && textHas(m.text, query)) out.push(i);
    });
    return out;
  }, [shown, query]);
  const matchIndex = matches.length ? Math.min(cur, matches.length - 1) : -1;
  useEffect(() => setCur(0), [query, chat.id]);
  useEffect(() => {
    if (matchIndex < 0) return;
    goTo(matches[matchIndex], "center");
  }, [matchIndex, matches, goTo]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
        window.setTimeout(() => searchRef.current?.select(), 0);
      }
      if (e.key === "Escape") setSearchOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const el = viewport();
    if (el) el.scrollTop = 0;
    setSearchOpen(false);
    setQ("");
  }, [chat.id, viewport]);

  const live = useRef({ start: 0, loading: false, partial: false, loadEarlier: p.onLoadEarlier });
  live.current = { start: page?.start ?? 0, loading: p.loadingEarlier, partial: !!page?.partial, loadEarlier: p.onLoadEarlier };
  const ticks = useMemo(() => shown.map((m, i) => ({ m, i })).filter((t) => t.m.role === "user" && t.m.kind === "text"), [shown]);
  useEffect(() => {
    const el = viewport();
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      // Near the top of what is loaded, the next earlier messages are read; the view stays where it is.
      if (live.current.start > 0 && !live.current.loading && !live.current.partial && !pinning.current && el.scrollTop - margin < 60) live.current.loadEarlier();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 240;
        setShowJump(el.scrollHeight - el.scrollTop - el.clientHeight > 400);
        setAtTop(el.scrollTop < 8);
        setAtEnd(el.scrollHeight - el.scrollTop - el.clientHeight < 8);
        const line = el.scrollTop + 120;
        // Ticks are in page order, so a binary search over the row positions finds the current one.
        let lo = 0;
        let hi = ticks.length - 1;
        let active = 0;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const row = virt.measurementsCache[blockOf[ticks[mid].i]];
          if (row && row.start <= line) {
            active = mid;
            lo = mid + 1;
          } else hi = mid - 1;
        }
        setActiveTick(active);
      });
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [viewport, ticks, page, virt, blockOf, margin]);


  const loadAll = async () => {
    setLoadingAll(true);
    try {
      await p.onLoadAll();
    } finally {
      setLoadingAll(false);
    }
  };

  const needsAll = searchOpen && !!query && !!page && page.start > 0;
  useEffect(() => {
    if (needsAll && !loadingAll) void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsAll]);

  // The timeline covers the whole chat: ticks come from the light outline, and the ones already loaded jump straight there.
  const barTicks = useMemo(() => {
    const keyOf = (ts: string, text: string) => `${ts}|${text.trim().slice(0, 60)}`;
    const loaded = new Map<string, number>();
    ticks.forEach((t, k) => loaded.set(keyOf(t.m.ts ?? "", t.m.text), k));
    const out: { key: string; i: number; text: string; ts?: string; loaded: boolean; k: number }[] = [];
    const used = new Set<string>();
    (p.outline ?? []).forEach((o) => {
      const key = keyOf(o.ts, o.text);
      const k = loaded.get(key);
      used.add(key);
      out.push({ key, i: k !== undefined ? ticks[k].i : -1, text: o.text, ts: o.ts, loaded: k !== undefined, k: k ?? -1 });
    });
    ticks.forEach((t, k) => {
      const key = keyOf(t.m.ts ?? "", t.m.text);
      if (!used.has(key)) out.push({ key, i: t.i, text: t.m.text, ts: t.m.ts, loaded: true, k });
    });
    return out;
  }, [ticks, p.outline]);
  const step = Math.max(1, Math.ceil(barTicks.length / 60));
  const sampled = barTicks.filter((t, n) => n % step === 0 || (t.loaded && t.k === activeTick));
  const pending = useRef<string | null>(null);
  useEffect(() => {
    const key = pending.current;
    if (!key) return;
    const hit = barTicks.find((t) => t.key === key && t.loaded);
    if (hit) {
      pending.current = null;
      goTo(hit.i, "start", true);
    }
  }, [barTicks, goTo]);

  return (
    <GalleryContext.Provider value={gallery}>
    <div className="flex min-h-0 flex-1 flex-col">
      {viewer !== null && <Lightbox images={images} index={Math.min(viewer, images.length - 1)} onIndex={setViewer} onClose={() => setViewer(null)} />}
      {!page ? (
        <HeaderSkeleton />
      ) : (
        <header className="border-b py-3">
          <div className="w-full space-y-3 px-4">
          <div className="flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted">
              <ProviderLogo provider={chat.provider} className="size-6" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="group/title flex items-center gap-1">
                <h2 className="truncate text-base font-medium leading-tight">{chat.title}</h2>
                {p.live && (
                  <Tip label={`${PROVIDER_SHORT[chat.provider]} is working in this chat right now`}>
                    <span className="relative ml-1 flex size-2 shrink-0">
                      <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                      <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
                    </span>
                  </Tip>
                )}
                <Tip label="Rename this chat in ChatVault.">
                  <Button variant="ghost" size="icon" className="size-6 shrink-0 text-muted-foreground opacity-0 group-hover/title:opacity-100 focus-visible:opacity-100" aria-label="Rename" onClick={p.onRename}>
                    <Pencil className="size-3.5" />
                  </Button>
                </Tip>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1">
                {[
                  chat.model ? { icon: Cpu, label: chat.model } : null,
                  chat.backup ? { icon: Archive, label: "Backup copy" } : null,
                  { icon: Clock, label: fmtDate(chat.lastMs) },
                  { icon: HardDrive, label: fmtSize(chat.size) },
                  { icon: MessageSquare, label: page.partial ? "Loading messages…" : `${page.total.toLocaleString()} messages` },
                ]
                  .filter((m): m is { icon: typeof Cpu; label: string } => m !== null)
                  .map((m) => (
                    <Badge key={m.label} variant="secondary" className="h-5 gap-1 rounded-md px-1.5 text-[11px] font-normal text-muted-foreground">
                      <m.icon className="size-3" strokeWidth={1.5} />
                      {m.label}
                    </Badge>
                  ))}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Tip label={p.pinned ? "Unpin this chat" : "Pin this chat to the top of the list"}>
                <Toggle aria-label="Pin" size="sm" pressed={p.pinned} onPressedChange={p.onTogglePin}>
                  {p.pinned ? <PinOff /> : <Pin />}
                </Toggle>
              </Tip>
              <Tip label="Search in this chat (Ctrl+F)">
                <Toggle
                  aria-label="Search in chat"
                  size="sm"
                  pressed={searchOpen}
                  onPressedChange={(v) => {
                    setSearchOpen(v);
                    if (v) window.setTimeout(() => searchRef.current?.focus(), 0);
                  }}
                >
                  <Search />
                </Toggle>
              </Tip>
              <Tip label={p.showSteps ? "Hide the steps the AI took" : "Show the steps the AI took"}>
                <Toggle aria-label="Show steps" size="sm" pressed={p.showSteps} onPressedChange={p.onToggleSteps}>
                  <ListTree />
                </Toggle>
              </Tip>
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
              <ActionsMenu chat={chat} msgs={page.messages} toast={p.toast} onRename={p.onRename} onDelete={p.onDelete} pinned={p.pinned} onTogglePin={p.onTogglePin} />
            </div>
          </div>

          </div>
        </header>
      )}

      <div ref={wrapRef} className="relative min-h-0 flex-1">
        {page && searchOpen && (
          <div className="absolute right-6 top-3 z-20 w-[min(26rem,calc(100%-3rem))] rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-lg">
            <div className="flex items-center gap-1">
              <Search className="ml-2 size-4 shrink-0 text-muted-foreground" />
              <Input
                ref={searchRef}
                className="h-8 border-0 bg-transparent px-2 shadow-none focus-visible:ring-0"
                placeholder="Find in this chat"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && matches.length) setCur((c) => (e.shiftKey ? (c - 1 + matches.length) % matches.length : (c + 1) % matches.length));
                }}
              />
              <span className="shrink-0 px-1 text-xs tabular-nums text-muted-foreground">{query ? (loadingAll ? "…" : matches.length ? `${matchIndex + 1}/${matches.length}` : "0/0") : ""}</span>
              <Button variant="ghost" size="icon" className="size-7" aria-label="Previous match" disabled={!matches.length} onClick={() => setCur((c) => (c - 1 + matches.length) % matches.length)}>
                <ChevronUp className="size-4" />
              </Button>
              <Button variant="ghost" size="icon" className="size-7" aria-label="Next match" disabled={!matches.length} onClick={() => setCur((c) => (c + 1) % matches.length)}>
                <ChevronDown className="size-4" />
              </Button>
              <Button variant="ghost" size="icon" className="size-7" aria-label="Close search" onClick={() => setSearchOpen(false)}>
                <X className="size-4" />
              </Button>
            </div>
          </div>
        )}

        <ScrollArea className="h-full">
          {!page ? (
            <MessagesSkeleton />
          ) : (
            <div className="mx-auto max-w-3xl px-4 pb-10 pt-4">
              {page.partial && (
                <div className="flex items-center justify-center gap-2 pb-7 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> Loading…
                </div>
              )}
              {!page.partial && page.start > 0 && (
                <div className="flex justify-center pb-7">
                  <Button size="sm" variant="outline" onClick={p.onLoadEarlier} disabled={p.loadingEarlier}>
                    {p.loadingEarlier ? <Loader2 className="size-4 animate-spin" /> : <ChevronUp className="size-4" />}
                    Load earlier messages ({page.start.toLocaleString()} more)
                  </Button>
                </div>
              )}
              <div ref={listRef} className="relative w-full" style={{ height: virt.getTotalSize() }}>
                {virt.getVirtualItems().map((vi) => {
                  const b = blocks[vi.index];
                  if (!b) return null;
                  return (
                    <div key={vi.key} data-index={vi.index} ref={virt.measureElement} className="absolute left-0 top-0 w-full pb-7" style={{ transform: `translateY(${vi.start - margin}px)` }}>
                      {b.kind === "plan" ? (
                        <PlanBlock item={b.m} />
                      ) : b.kind === "agent" ? (
                        <SubagentBlock item={b.m} />
                      ) : b.kind === "trace" ? (
                        <StepsTrace items={b.items} q={query} />
                      ) : (
                        <MessageRow m={b.m} provider={chat.provider} q={query} isCurrentMatch={matchIndex >= 0 && matches[matchIndex] === b.i} toast={p.toast} />
                      )}
                    </div>
                  );
                })}
              </div>
              {p.live && (
                <div className="flex items-center gap-3 pt-2" aria-live="polite">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
                    <ProviderLogo provider={chat.provider} className="size-5 animate-pulse" />
                  </div>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <span className="animate-pulse">{PROVIDER_SHORT[chat.provider]} is working</span>
                    <span className="flex gap-[3px]">
                      {[0, 200, 400].map((d) => (
                        <span key={d} className="size-[3px] animate-pulse rounded-full bg-muted-foreground/60" style={{ animationDelay: `${d}ms`, animationDuration: "1.4s" }} />
                      ))}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </ScrollArea>

        {page && sampled.length >= 3 && (
          <ConversationBar
            ticks={sampled.map((t, n) => ({ i: n, text: t.text, ts: t.ts ?? "", active: t.loaded && t.k === activeTick }))}
            onNear={(n) => {
              const t = sampled[n];
              if (t && !t.loaded && p.onLoadUntil && t.ts) void p.onLoadUntil(t.ts);
            }}
            onPick={(n) => {
              const t = sampled[n];
              if (!t) return;
              if (t.loaded) goTo(t.i, "start", true);
              else if (p.onLoadUntil && t.ts) {
                pending.current = t.key;
                void p.onLoadUntil(t.ts);
              }
            }}
          />
        )}

        <div className={cn("pointer-events-none absolute inset-x-0 top-0 z-10 h-12 bg-gradient-to-b from-background via-background/70 to-transparent transition-opacity duration-200", atTop ? "opacity-0" : "opacity-100")} />
        <div className={cn("pointer-events-none absolute inset-x-0 bottom-0 z-10 h-20 bg-gradient-to-t from-background via-background/70 to-transparent transition-opacity duration-200", atEnd ? "opacity-0" : "opacity-100")} />

        {showJump && (
          <Button
            size="icon"
            aria-label="Scroll to the bottom"
            className="absolute bottom-4 left-1/2 z-20 size-9 -translate-x-1/2 rounded-full shadow-md"
            onClick={() => {
              const el = viewport();
              if (!el) return;
              // Straight to the end, then once more as the last rows are measured.
              jumpNow(el.scrollHeight);
              requestAnimationFrame(() => jumpNow(el.scrollHeight));
              window.setTimeout(() => jumpNow(el.scrollHeight), 120);
            }}
          >
            <ArrowDown className="size-4" />
          </Button>
        )}
      </div>
    </div>
    </GalleryContext.Provider>
  );
}

function ActionsMenu({ chat, msgs, toast, onRename, onDelete, pinned, onTogglePin }: { chat: Chat; msgs: Msg[]; toast: (m: string) => void; onRename: () => void; onDelete: () => void; pinned: boolean; onTogglePin: () => void }) {
  const actions = chatActions(chat, toast, msgs);
  const groups = ["Continue", "More"] as const;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size="sm" />}>
        Actions <ChevronDown className="size-3.5 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Chat</DropdownMenuLabel>
          <DropdownMenuItem onClick={onRename}>
            <Pencil className="size-4" strokeWidth={1.5} /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onTogglePin}>
            {pinned ? <PinOff className="size-4" strokeWidth={1.5} /> : <Pin className="size-4" strokeWidth={1.5} />} {pinned ? "Unpin" : "Pin to top"}
          </DropdownMenuItem>
        </DropdownMenuGroup>
        {groups.map((g) => {
          const items = actions.filter((a) => (g === "More" ? ["Open", "Copy", "Save"].includes(a.group) : a.group === g));
          if (!items.length) return null;
          return (
            <div key={g}>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>{g}</DropdownMenuLabel>
                {items.map((a) => {
                  const Icon = a.icon;
                  return (
                    <DropdownMenuItem key={a.id} onClick={() => a.run().catch((e) => toast(String(e)))}>
                      <Icon className="size-4" strokeWidth={1.5} /> {a.label}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuGroup>
            </div>
          );
        })}
        {chat.provider !== "cursor" && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Trash2 className="size-4" strokeWidth={1.5} /> Delete chat
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A run of tool steps, collapsed to one line with the shadcn Trace. */
function StepsTrace({ items, q }: { items: { i: number; m: Item }[]; q: string }) {
  const [open, setOpen] = useState(false);
  const hasMatch = !!q && items.some((t) => textHas(t.m.text, q));
  const names = Array.from(new Set(items.map((t) => stepName(t.m))));
  return (
    <Trace className="pl-11">
      <TraceCollapsible open={open || hasMatch} onOpenChange={setOpen}>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceIcon>
              <ListTree />
            </TraceIcon>
            <TraceTitle>
              {items.length} {items.length === 1 ? "step" : "steps"}
            </TraceTitle>
            <TraceDescription className="max-w-64 truncate">{names.slice(0, 3).join(", ")}</TraceDescription>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <div className="space-y-1.5">
            {items.map(({ i, m }) => (
              <StepItem key={i} item={m} q={q} />
            ))}
          </div>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}

function MessageRow({ m, provider, q, isCurrentMatch, toast }: { m: Msg; provider: Provider; q: string; isCurrentMatch: boolean; toast: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const time = m.ts ? new Date(m.ts).toLocaleTimeString(undefined, { timeStyle: "short" }) : "";
  const isUser = m.role === "user";
  const who = isUser ? "You" : PROVIDER_SHORT[provider];

  if (m.kind === "summary") {
    return (
      <div className="rounded-lg border border-dashed p-3 text-sm">
        <button className="flex items-center gap-1.5 text-muted-foreground" onClick={() => setOpen((o) => !o)}>
          {open || q ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          Earlier part was summarized here
        </button>
        {(open || q) && (
          <pre className="mt-2 whitespace-pre-wrap font-sans text-xs text-muted-foreground">
            <Highlight text={m.text} q={q} activeMark={isCurrentMatch} />
          </pre>
        )}
      </div>
    );
  }

  const long = m.text.length > 1800;
  const expanded = open || !!q;
  const text = long && !expanded ? m.text.slice(0, 1800) + "…" : m.text;
  const copy = async (what: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      window.setTimeout(() => setCopied(null), 1400);
    } catch {
      toast("Could not copy");
    }
  };

  return (
    <Message align={isUser ? "end" : "start"}>
      <MessageAvatar className="self-start bg-transparent">
        <Avatar>
          <AvatarFallback className={cn("overflow-hidden", isUser ? "bg-secondary text-secondary-foreground" : provider === "codex" ? "bg-transparent" : "bg-muted")}>
            {isUser ? <User className="size-4" /> : <ProviderLogo provider={provider} className={provider === "codex" ? "size-full" : "size-5"} />}
          </AvatarFallback>
        </Avatar>
      </MessageAvatar>
      <MessageContent>
        <MessageHeader className={cn("gap-2", isUser && "flex-row-reverse")}>
          <span className="text-foreground">{who}</span>
          <span className="font-normal">{time}</span>
          <div className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100">
            <MiniAction label={copied === "text" ? "Copied" : "Copy message"} onClick={() => copy("text", m.text)}>
              {copied === "text" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </MiniAction>
            <MiniAction label={copied === "md" ? "Copied" : "Copy as Markdown"} onClick={() => copy("md", `**${who}** · ${time}\n\n${m.text}`)}>
              {copied === "md" ? <Check className="size-3.5" /> : <FileText className="size-3.5" />}
            </MiniAction>
            <MiniAction label={copied === "quote" ? "Copied" : "Copy as quote"} onClick={() => copy("quote", m.text.split("\n").map((l) => `> ${l}`).join("\n"))}>
              {copied === "quote" ? <Check className="size-3.5" /> : <Quote className="size-3.5" />}
            </MiniAction>
          </div>
        </MessageHeader>
        {m.kind === "image" && typeof m.data === "string" ? (
          <div className={cn("max-w-full", isUser && "flex justify-end")}>
            <ChatImage src={m.data} />
          </div>
        ) : (
        <Bubble variant={isUser ? "secondary" : "outline"} className="max-w-full">
          <BubbleContent className="overflow-visible">
            {m.kind === "image" ? <span className="text-muted-foreground">[Image]</span> : <MessageBody text={text} q={q} active={isCurrentMatch} assistant={!isUser} />}
            {long && !q && (
              <button className="mt-1 text-xs text-muted-foreground underline" onClick={() => setOpen((o) => !o)}>
                {open ? "Show less" : "Show all"}
              </button>
            )}
          </BubbleContent>
        </Bubble>
        )}
      </MessageContent>
    </Message>
  );
}

function MiniAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon" className="size-6" aria-label={label} onClick={onClick} />}>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}


type BarTick = { i: number; text: string; ts: string; active: boolean };

const PITCH = 8; // height of one tick row, in px
const PAD = 12; // top padding of the bar, in px

/**
 * The strip of ticks beside the chat. Ticks swell like a wave around the pointer and the closest one
 * turns dark and previews that question. The pointer position is turned into a tick index with plain
 * arithmetic and animated with transforms, so nothing is measured while you move.
 */
function ConversationBar({ ticks, onPick, onNear }: { ticks: BarTick[]; onPick: (i: number) => void; onNear?: (i: number) => void }) {
  const navRef = useRef<HTMLElement | null>(null);
  const topRef = useRef(0);
  const frame = useRef(0);
  // Fractional tick position under the pointer, or null when it is away.
  const [pos, setPos] = useState<number | null>(null);

  const onMove = (e: React.MouseEvent) => {
    const y = e.clientY;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => setPos((y - topRef.current - PAD) / PITCH - 0.5));
  };
  const nearest = pos === null ? -1 : Math.min(ticks.length - 1, Math.max(0, Math.round(pos)));
  const near = ticks[nearest];
  const head = near?.text.trim().split("\n")[0] ?? "";

  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  // Hovering a tick lets the chat quietly fetch what that tick needs, so the click lands without any waiting.
  useEffect(() => {
    if (nearest < 0 || !onNear) return;
    const t = window.setTimeout(() => onNear(nearest), 120);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nearest]);

  return (
    <nav
      ref={navRef}
      aria-label="Conversation"
      className="absolute left-0 top-1/2 z-10 flex max-h-[80%] -translate-y-1/2 cursor-pointer flex-col pl-3 pr-5"
      style={{ paddingTop: PAD, paddingBottom: PAD }}
      onMouseEnter={(e) => {
        topRef.current = e.currentTarget.getBoundingClientRect().top;
      }}
      onMouseMove={onMove}
      onMouseLeave={() => {
        cancelAnimationFrame(frame.current);
        setPos(null);
      }}
      onClick={() => near && onPick(near.i)}
    >
      {ticks.map((t, idx) => {
        // A smooth bump centred on the pointer, about two ticks wide.
        const f = pos === null ? 0 : Math.exp(-Math.pow(idx - pos, 2) / 5);
        const hot = pos !== null ? idx === nearest : t.active;
        const scale = ((hot ? 22 : 10) + 22 * f) / 44;
        return (
          <div key={t.i} className="flex items-center" style={{ height: PITCH }}>
            <div
              className={cn("w-11 origin-left rounded-full transition-[transform,opacity,background-color] duration-100 ease-out will-change-transform", hot ? "bg-foreground" : "bg-muted-foreground")}
              style={{ height: hot ? 2.5 : f > 0.5 ? 2 : 1.5, transform: `scaleX(${scale})`, opacity: hot ? 1 : 0.5 + 0.35 * f }}
            />
          </div>
        );
      })}
      {near && pos !== null && (
        <div
          className="pointer-events-none absolute left-full z-20 ml-1 w-72 rounded-xl border bg-popover p-3 text-popover-foreground shadow-md"
          style={{ top: PAD + nearest * PITCH + PITCH / 2, transform: "translateY(-50%)" }}
        >
          <p className="line-clamp-2 text-xs font-medium">{head}</p>
          <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">{near.text.trim().slice(head.length).trim() || (near.ts ? fmtDate(Date.parse(near.ts)) : "")}</p>
        </div>
      )}
    </nav>
  );
}
