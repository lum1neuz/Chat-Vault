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
  PanelTopClose,
  PanelTopOpen,
  Pencil,
  Pin,
  PinOff,
  Quote,
  Search,
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
import { cn } from "@/lib/utils";
import { ProviderLogo } from "@/claude-logo";
import { Highlight, MessageBody } from "@/message-body";
import { PROVIDER_NAME, accountLabel, chatActions, fmtDate, fmtSize, type Chat, type ChatAction, type Msg, type MsgPage, type Provider } from "@/chat-actions";
import { HeaderSkeleton, MessagesSkeleton } from "@/skeletons";

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

type Block = { kind: "msg"; i: number; m: Msg } | { kind: "trace"; i: number; items: { i: number; m: Msg }[] };

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

  const shown = useMemo(() => (page ? page.messages.filter((m) => p.showSteps || m.kind !== "tool") : []), [page, p.showSteps]);
  const viewport = useCallback(() => wrapRef.current?.querySelector<HTMLElement>("[data-slot=scroll-area-viewport]") ?? null, []);

  // Consecutive tool steps collapse into one Trace.
  const blocks = useMemo(() => {
    const out: Block[] = [];
    shown.forEach((m, i) => {
      if (m.kind === "tool") {
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
        <header className="border-b">
          <div className="flex items-center gap-3 px-4 pt-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
              <ProviderLogo provider={chat.provider} className="size-5" />
            </div>
            <div className="group/title flex min-w-0 flex-1 items-center gap-1">
              <h2 className="truncate text-base font-medium">{chat.title}</h2>
              <Tip label="Rename this chat in ChatVault.">
                <Button variant="ghost" size="icon" className="size-7 shrink-0 text-muted-foreground opacity-0 group-hover/title:opacity-100 focus-visible:opacity-100" aria-label="Rename" onClick={p.onRename}>
                  <Pencil className="size-3.5" />
                </Button>
              </Tip>
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
              <Tip label={p.headerOpen ? "Hide chat details" : "Show chat details"}>
                <Toggle aria-label="Chat details" size="sm" pressed={p.headerOpen} onPressedChange={p.onToggleHeader}>
                  {p.headerOpen ? <PanelTopClose /> : <PanelTopOpen />}
                </Toggle>
              </Tip>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
            {slotActions.map((a) => (
              <Tip key={a.id} label={a.hint}>
                <RunButton action={a} primary={a.slot === 1} onError={p.toast} />
              </Tip>
            ))}
            <ActionsMenu chat={chat} msgs={page.messages} toast={p.toast} onRename={p.onRename} pinned={p.pinned} onTogglePin={p.onTogglePin} />
          </div>

          {p.headerOpen && (
            <div className="flex flex-wrap items-center gap-1.5 px-4 pt-3">
              <Badge variant="outline" className="gap-1">
                <ProviderLogo provider={chat.provider} className="size-3" /> {PROVIDER_NAME[chat.provider]}
              </Badge>
              <Badge variant="outline">{accountLabel(chat.account)}</Badge>
              <Badge variant="outline">{chat.project}</Badge>
              {chat.model && <Badge variant="outline">{chat.model}</Badge>}
              {chat.backup && <Badge variant="outline">Backup copy</Badge>}
              <span className="text-xs text-muted-foreground">
                {fmtDate(chat.lastMs)} · {fmtSize(chat.size)} · {page.total.toLocaleString()} messages
              </span>
            </div>
          )}

          {searchOpen && (
            <div className="flex items-center gap-2 px-4 pt-3">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
                <Input
                  ref={searchRef}
                  className="h-9 pl-8"
                  placeholder="Search in this chat"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && matches.length) setCur((c) => (e.shiftKey ? (c - 1 + matches.length) % matches.length : (c + 1) % matches.length));
                  }}
                />
              </div>
              <span className="w-20 shrink-0 text-center text-xs text-muted-foreground">
                {query ? (matches.length ? `${matchIndex + 1} of ${matches.length}` : "No matches") : ""}
              </span>
              <Button variant="outline" size="icon" aria-label="Previous match" disabled={!matches.length} onClick={() => setCur((c) => (c - 1 + matches.length) % matches.length)}>
                <ChevronUp className="size-4" />
              </Button>
              <Button variant="outline" size="icon" aria-label="Next match" disabled={!matches.length} onClick={() => setCur((c) => (c + 1) % matches.length)}>
                <ChevronDown className="size-4" />
              </Button>
              <Button variant="ghost" size="icon" aria-label="Close search" onClick={() => setSearchOpen(false)}>
                <X className="size-4" />
              </Button>
            </div>
          )}
          {searchOpen && page.start > 0 && (
            <div className="flex items-center gap-2 px-4 pt-2 text-xs text-muted-foreground">
              Searching the latest {page.messages.length.toLocaleString()} messages.
              <Button variant="link" size="sm" className="h-auto p-0 text-xs" disabled={loadingAll} onClick={loadAll}>
                {loadingAll ? "Loading…" : `Load all ${page.total.toLocaleString()} messages`}
              </Button>
            </div>
          )}
          <div className="h-3" />
        </header>
      )}

      <div ref={wrapRef} className="relative min-h-0 flex-1">
        <ScrollArea className="h-full">
          {!page ? (
            <MessagesSkeleton />
          ) : (
            <div className="mx-auto max-w-3xl space-y-5 p-4 pl-12">
              {page.start > 0 && (
                <div className="flex justify-center">
                  <Button size="sm" variant="outline" onClick={p.onLoadEarlier} disabled={p.loadingEarlier}>
                    {p.loadingEarlier ? <Loader2 className="size-4 animate-spin" /> : <ChevronUp className="size-4" />}
                    Load earlier messages ({page.start.toLocaleString()} more)
                  </Button>
                </div>
              )}
              {blocks.map((b) =>
                b.kind === "trace" ? (
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
          <nav aria-label="Conversation" className="absolute left-3 top-1/2 z-10 flex max-h-[70%] -translate-y-1/2 flex-col gap-1.5 overflow-visible py-2">
            {sampled.map((t) => {
              const k = ticks.indexOf(t);
              const active = k === activeTick;
              const head = t.m.text.trim().split("\n")[0];
              return (
                <div key={t.i} className="group/tick relative flex h-2 items-center">
                  <button
                    aria-label={head}
                    className={cn("h-0.5 rounded-full transition-all", active ? "w-5 bg-foreground" : "w-3 bg-muted-foreground/40 hover:w-5 hover:bg-foreground")}
                    onClick={() => els.current[t.i]?.scrollIntoView({ block: "start", behavior: "smooth" })}
                  />
                  <div className="pointer-events-none absolute left-8 top-1/2 z-20 hidden w-72 -translate-y-1/2 rounded-xl border bg-popover p-3 text-popover-foreground shadow-md group-hover/tick:block">
                    <p className="line-clamp-2 text-xs font-medium uppercase tracking-wide">{head}</p>
                    <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">{t.m.text.trim().slice(head.length).trim() || (t.m.ts ? fmtDate(Date.parse(t.m.ts)) : "")}</p>
                  </div>
                </div>
              );
            })}
          </nav>
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

function ActionsMenu({ chat, msgs, toast, onRename, pinned, onTogglePin }: { chat: Chat; msgs: Msg[]; toast: (m: string) => void; onRename: () => void; pinned: boolean; onTogglePin: () => void }) {
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A run of tool steps, collapsed to one line with the shadcn Trace. */
function StepsTrace({ items, q }: { items: { i: number; m: Msg }[]; q: string }) {
  const [open, setOpen] = useState(false);
  const hasMatch = !!q && items.some((t) => t.m.text.toLowerCase().includes(q.toLowerCase()));
  const split = (text: string) => {
    const k = text.indexOf(": ");
    return k > 0 ? [text.slice(0, k), text.slice(k + 2)] : [text, ""];
  };
  const names = Array.from(new Set(items.map((t) => split(t.m.text)[0])));
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
          <div className="mt-2 space-y-1.5 border-l pl-3">
            {items.map(({ i, m }) => {
              const [name, detail] = split(m.text);
              return (
                <Trace key={i}>
                  <TraceLine>
                    <TraceTitle className="font-medium text-foreground/80">
                      <Highlight text={name} q={q} activeMark={false} />
                    </TraceTitle>
                    {detail && (
                      <TraceDescription className="truncate font-mono text-xs">
                        <Highlight text={detail} q={q} activeMark={false} />
                      </TraceDescription>
                    )}
                  </TraceLine>
                </Trace>
              );
            })}
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
  const who = isUser ? "You" : provider === "claude" ? "Claude" : "Codex";

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
      <MessageAvatar className="self-start">
        <Avatar size="sm">
          <AvatarFallback className="bg-muted">{isUser ? <User className="size-3.5" /> : <ProviderLogo provider={provider} className="size-4" />}</AvatarFallback>
        </Avatar>
      </MessageAvatar>
      <MessageContent>
        <MessageHeader className={cn("gap-2", isUser && "justify-end")}>
          <span className="text-foreground">{who}</span>
          <span className="font-normal">{time}</span>
        </MessageHeader>
        <Bubble variant={isUser ? "secondary" : "outline"} className={cn("max-w-full", isCurrentMatch && "*:data-[slot=bubble-content]:ring-2 *:data-[slot=bubble-content]:ring-primary/60")}>
          <BubbleContent className="overflow-visible">
            {m.kind === "image" ? <span className="text-muted-foreground">[Image]</span> : <MessageBody text={text} q={q} active={isCurrentMatch} />}
            {long && !q && (
              <button className="mt-1 text-xs text-muted-foreground underline" onClick={() => setOpen((o) => !o)}>
                {open ? "Show less" : "Show all"}
              </button>
            )}
          </BubbleContent>
          <div
            className={cn(
              "absolute -top-3 flex items-center gap-0.5 rounded-lg border bg-popover p-0.5 opacity-0 shadow-sm transition-opacity group-hover/message:opacity-100 focus-within:opacity-100",
              isUser ? "right-2" : "left-2",
            )}
          >
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
