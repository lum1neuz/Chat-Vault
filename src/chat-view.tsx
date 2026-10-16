import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import {
  ArrowDown,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  FileText,
  ListTree,
  Loader2,
  MoreHorizontal,
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
import { cn } from "@/lib/utils";
import { ProviderLogo } from "@/claude-logo";
import { Highlight, MessageBody } from "@/message-body";
import { PROVIDER_NAME, PROVIDER_SHORT, accountLabel, chatActions, fmtDate, fmtSize, type Chat, type ChatAction, type Msg, type MsgPage, type Provider } from "@/chat-actions";
import { HeaderSkeleton, MessagesSkeleton } from "@/skeletons";
import { PlanBlock, StepItem, SubagentBlock, isAgent, isPlan, mergeResults, stepName, type Item } from "@/steps";

type Props = {
  chat: Chat;
  page: MsgPage | null;
  loadingEarlier: boolean;
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
  const [activeTick, setActiveTick] = useState(0);
  const [loadingAll, setLoadingAll] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const els = useRef<Record<number, HTMLElement | null>>({});

  const merged = useMemo(() => (page ? mergeResults(page.messages) : []), [page]);
  const shown = useMemo(() => merged.filter((m) => p.showSteps || (m.kind !== "tool" && m.kind !== "reasoning")), [merged, p.showSteps]);
  const viewport = useCallback(() => wrapRef.current?.querySelector<HTMLElement>("[data-slot=scroll-area-viewport]") ?? null, []);

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

  const query = searchOpen ? q.trim() : "";
  const matches = useMemo(() => {
    if (!query) return [] as number[];
    const lq = query.toLowerCase();
    const out: number[] = [];
    shown.forEach((m, i) => {
      if (m.kind !== "image" && m.text.toLowerCase().includes(lq)) out.push(i);
    });
    return out;
  }, [shown, query]);
  const matchIndex = matches.length ? Math.min(cur, matches.length - 1) : -1;
  useEffect(() => setCur(0), [query, chat.id]);
  useEffect(() => {
    if (matchIndex < 0) return;
    els.current[matches[matchIndex]]?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [matchIndex, matches]);

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

  const ticks = useMemo(() => shown.map((m, i) => ({ m, i })).filter((t) => t.m.role === "user" && t.m.kind === "text"), [shown]);
  useEffect(() => {
    const el = viewport();
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        setShowJump(el.scrollHeight - el.scrollTop - el.clientHeight > 400);
        const line = el.scrollTop + 120;
        let active = 0;
        ticks.forEach((t, k) => {
          const node = els.current[t.i];
          if (node && node.offsetTop <= line) active = k;
        });
        setActiveTick(active);
      });
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [viewport, ticks, page]);

  const slotActions = chatActions(chat, p.toast, page?.messages).filter((a) => a.slot).sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));

  const loadAll = async () => {
    setLoadingAll(true);
    try {
      await p.onLoadAll();
    } finally {
      setLoadingAll(false);
    }
  };

  const step = Math.max(1, Math.ceil(ticks.length / 60));
  const sampled = ticks.filter((_, k) => k % step === 0 || k === activeTick);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!page ? (
        <HeaderSkeleton />
      ) : (
        <header className="space-y-3 border-b px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted">
              <ProviderLogo provider={chat.provider} className="size-6" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="group/title flex items-center gap-1">
                <h2 className="truncate text-base font-medium leading-tight">{chat.title}</h2>
                <Tip label="Rename this chat in ChatVault.">
                  <Button variant="ghost" size="icon" className="size-6 shrink-0 text-muted-foreground opacity-0 group-hover/title:opacity-100 focus-visible:opacity-100" aria-label="Rename" onClick={p.onRename}>
                    <Pencil className="size-3.5" />
                  </Button>
                </Tip>
              </div>
              <p className="truncate text-xs text-muted-foreground">
                {[PROVIDER_NAME[chat.provider], accountLabel(chat.account), chat.project, chat.model, chat.backup ? "Backup copy" : null].filter(Boolean).join(" · ")}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {fmtDate(chat.lastMs)} · {fmtSize(chat.size)} · {page.total.toLocaleString()} messages
              </p>
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
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {slotActions.map((a) => (
              <Tip key={a.id} label={a.hint}>
                <RunButton action={a} primary={a.slot === 1} onError={p.toast} />
              </Tip>
            ))}
            <ActionsMenu chat={chat} msgs={page.messages} toast={p.toast} onRename={p.onRename} onDelete={p.onDelete} pinned={p.pinned} onTogglePin={p.onTogglePin} />
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
              <span className="shrink-0 px-1 text-xs tabular-nums text-muted-foreground">{query ? (matches.length ? `${matchIndex + 1}/${matches.length}` : "0/0") : ""}</span>
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
            {page.start > 0 && (
              <p className="px-2 pb-1 pt-0.5 text-xs text-muted-foreground">
                Searching the latest {page.messages.length.toLocaleString()} messages.{" "}
                <button className="underline disabled:opacity-60" disabled={loadingAll} onClick={loadAll}>
                  {loadingAll ? "Loading…" : "Load all"}
                </button>
              </p>
            )}
          </div>
        )}

        <ScrollArea className="h-full">
          {!page ? (
            <MessagesSkeleton />
          ) : (
            <div className="mx-auto max-w-3xl space-y-7 p-4 pl-12">
              {page.start > 0 && (
                <div className="flex justify-center">
                  <Button size="sm" variant="outline" onClick={p.onLoadEarlier} disabled={p.loadingEarlier}>
                    {p.loadingEarlier ? <Loader2 className="size-4 animate-spin" /> : <ChevronUp className="size-4" />}
                    Load earlier messages ({page.start.toLocaleString()} more)
                  </Button>
                </div>
              )}
              {blocks.map((b) =>
                b.kind === "plan" ? (
                  <div key={`${page.start}-p${b.i}`} ref={(el) => { els.current[b.i] = el; }}>
                    <PlanBlock item={b.m} />
                  </div>
                ) : b.kind === "agent" ? (
                  <div key={`${page.start}-a${b.i}`} ref={(el) => { els.current[b.i] = el; }}>
                    <SubagentBlock item={b.m} />
                  </div>
                ) : b.kind === "trace" ? (
                  <div key={`${page.start}-t${b.i}`} ref={(el) => { els.current[b.i] = el; }}>
                    <StepsTrace items={b.items} q={query} />
                  </div>
                ) : (
                  <div key={`${page.start}-${b.i}`} ref={(el) => { els.current[b.i] = el; }}>
                    <MessageRow m={b.m} provider={chat.provider} q={query} isCurrentMatch={matchIndex >= 0 && matches[matchIndex] === b.i} toast={p.toast} />
                  </div>
                ),
              )}
            </div>
          )}
        </ScrollArea>

        {page && sampled.length >= 3 && (
          <ConversationBar
            ticks={sampled.map((t) => ({ i: t.i, text: t.m.text, ts: t.m.ts, active: ticks.indexOf(t) === activeTick }))}
            onPick={(i) => els.current[i]?.scrollIntoView({ block: "start", behavior: "smooth" })}
          />
        )}

        {showJump && (
          <Button
            size="icon"
            aria-label="Scroll to the bottom"
            className="absolute bottom-4 left-1/2 size-9 -translate-x-1/2 rounded-full shadow-md"
            onClick={() => viewport()?.scrollTo({ top: viewport()!.scrollHeight, behavior: "smooth" })}
          >
            <ArrowDown className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}

function RunButton({ action, primary, onError }: { action: ChatAction; primary?: boolean; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const Icon = action.icon;
  return (
    <Button
      size="sm"
      variant={primary ? "default" : "outline"}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await action.run();
        } catch (e) {
          onError(String(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Loader2 className="size-4 animate-spin" /> : <Icon className="size-4" />} {action.label}
    </Button>
  );
}

function ActionsMenu({ chat, msgs, toast, onRename, onDelete, pinned, onTogglePin }: { chat: Chat; msgs: Msg[]; toast: (m: string) => void; onRename: () => void; onDelete: () => void; pinned: boolean; onTogglePin: () => void }) {
  const actions = chatActions(chat, toast, msgs).filter((a) => !a.slot);
  const groups = ["Continue", "Open", "Copy", "Save"] as const;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size="sm" variant="outline" />}>
        <MoreHorizontal className="size-4" /> Actions <ChevronDown className="size-3.5 text-muted-foreground" />
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
          const items = actions.filter((a) => a.group === g);
          if (!items.length) return null;
          return (
            <div key={g}>
              <DropdownMenuSeparator />
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
  const hasMatch = !!q && items.some((t) => t.m.text.toLowerCase().includes(q.toLowerCase()));
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
        <Bubble variant={isUser ? "secondary" : "outline"} className={cn("max-w-full", isCurrentMatch && "*:data-[slot=bubble-content]:ring-2 *:data-[slot=bubble-content]:ring-primary/60")}>
          <BubbleContent className="overflow-visible">
            {m.kind === "image" ? <span className="text-muted-foreground">[Image]</span> : <MessageBody text={text} q={q} active={isCurrentMatch} assistant={!isUser} />}
            {long && !q && (
              <button className="mt-1 text-xs text-muted-foreground underline" onClick={() => setOpen((o) => !o)}>
                {open ? "Show less" : "Show all"}
              </button>
            )}
          </BubbleContent>
        </Bubble>
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

/**
 * The strip of ticks beside the chat. Ticks swell like a wave around the pointer, and the
 * closest one shows a preview of that question.
 */
function ConversationBar({ ticks, onPick }: { ticks: BarTick[]; onPick: (i: number) => void }) {
  const navRef = useRef<HTMLElement | null>(null);
  const tickRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [y, setY] = useState<number | null>(null);

  // Distance from the pointer to every tick, measured when the pointer moves.
  const navTop = navRef.current?.getBoundingClientRect().top ?? 0;
  const centers = ticks.map((_, idx) => {
    const r = tickRefs.current[idx]?.getBoundingClientRect();
    return r ? r.top + r.height / 2 : null;
  });
  let nearest = -1;
  let best = Infinity;
  if (y !== null) {
    centers.forEach((c, idx) => {
      if (c === null) return;
      const d = Math.abs(y - c);
      if (d < best) {
        best = d;
        nearest = idx;
      }
    });
  }
  const near = ticks[nearest];
  const head = near?.text.trim().split("\n")[0] ?? "";

  return (
    <nav
      ref={navRef}
      aria-label="Conversation"
      className="absolute left-0 top-1/2 z-10 flex max-h-[70%] -translate-y-1/2 flex-col gap-1.5 py-3 pl-3 pr-5"
      onMouseMove={(e) => setY(e.clientY)}
      onMouseLeave={() => setY(null)}
    >
      {ticks.map((t, idx) => {
        const c = centers[idx];
        const d = y !== null && c !== null ? Math.abs(y - c) : Infinity;
        const f = Math.exp(-Math.pow(d / 36, 2));
        const width = (t.active ? 20 : 10) + 22 * f;
        return (
          <div
            key={t.i}
            ref={(el) => {
              tickRefs.current[idx] = el;
            }}
            className="flex h-2 cursor-pointer items-center"
            onClick={() => onPick(t.i)}
          >
            <div
              className={cn("rounded-full transition-[width,opacity,height] duration-100 ease-out", t.active ? "bg-foreground" : "bg-muted-foreground")}
              style={{ width, height: t.active ? 2 : 1 + 0.5 * f, opacity: t.active ? 1 : 0.35 + 0.3 * f }}
            />
          </div>
        );
      })}
      {near && y !== null && centers[nearest] !== null && (
        <div
          className="pointer-events-none absolute left-full z-20 ml-1 w-72 rounded-xl border bg-popover p-3 text-popover-foreground shadow-md"
          style={{ top: (centers[nearest] as number) - navTop, transform: "translateY(-50%)" }}
        >
          <p className="line-clamp-2 text-xs font-medium">{head}</p>
          <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">{near.text.trim().slice(head.length).trim() || (near.ts ? fmtDate(Date.parse(near.ts)) : "")}</p>
        </div>
      )}
    </nav>
  );
}
