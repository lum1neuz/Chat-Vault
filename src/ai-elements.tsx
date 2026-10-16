import { Fragment, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowUpRight, CircleX, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
import { Highlight } from "@/highlight";

export const URL_RE = /https?:\/\/[^\s)<>"'\]]+/g;

export function hostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function uniqueUrls(text: string) {
  return Array.from(new Set((text.match(URL_RE) ?? []).map((u) => u.replace(/[.,;:]+$/, ""))));
}

const open = (url: string) => (e: { preventDefault: () => void }) => {
  e.preventDefault();
  openUrl(url).catch(() => {});
};

/** A source shown inline: a small chip that previews the link on hover. */
export function Cite({ url, label }: { url: string; label?: string }) {
  const host = hostname(url);
  return (
    <HoverCard>
      <HoverCardTrigger
        render={
          <Button variant="secondary" size="xs" className="mx-0.5 h-5 max-w-48 px-1.5 align-baseline" onClick={open(url)}>
            <span className="truncate">{label && label !== url ? label : host}</span>
          </Button>
        }
      />
      <HoverCardContent className="flex w-64 flex-col gap-1">
        <div className="break-words text-sm font-medium">{label && label !== url ? label : host}</div>
        <a href={url} onClick={open(url)} className="break-all text-xs text-muted-foreground underline-offset-2 hover:underline">
          {url}
          <span className="sr-only"> (opens in your browser)</span>
        </a>
      </HoverCardContent>
    </HoverCard>
  );
}

const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s)<>"'\]]+)/g;

/** Text with markdown links and bare URLs turned into inline citations. */
export function Linkified({ text, q, active }: { text: string; q: string; active: boolean }) {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let first = active;
  const plain = (s: string, key: string) => {
    if (!s) return;
    out.push(
      <Fragment key={key}>
        <Highlight text={s} q={q} activeMark={first} />
      </Fragment>,
    );
    if (q && s.toLowerCase().includes(q.toLowerCase())) first = false;
  };
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(text))) {
    plain(text.slice(last, m.index), `t${m.index}`);
    const url = (m[2] ?? m[3]).replace(/[.,;:]+$/, "");
    out.push(<Cite key={`c${m.index}`} url={url} label={m[1]} />);
    last = m.index + m[0].length - ((m[2] ?? m[3]).length - url.length);
  }
  plain(text.slice(last), "end");
  return <>{out}</>;
}

/** "Used N sources", listing every link a message cites. */
export function SourcesTrace({ urls }: { urls: string[] }) {
  if (urls.length < 2) return null;
  return (
    <Trace className="mt-2">
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceIcon>
              <Globe />
            </TraceIcon>
            <TraceTitle>Used {urls.length} sources</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <Trace>
            {urls.map((u) => (
              <a key={u} href={u} onClick={open(u)}>
                <TraceLine>
                  <TraceIcon>
                    <Globe />
                  </TraceIcon>
                  <TraceTitle>
                    {hostname(u)}
                    <span className="sr-only"> (opens in your browser)</span>
                  </TraceTitle>
                  <TraceIcon>
                    <ArrowUpRight />
                  </TraceIcon>
                </TraceLine>
              </a>
            ))}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}

export const STACK_RE = /(?:^|\n)((?:[A-Za-z_.]*(?:Error|Exception)[^\n]*\n(?:[ \t]+at [^\n]+\n?){2,})|(?:Traceback \(most recent call last\):\n(?:[ \t]+[^\n]+\n)+[^\n]*))/g;

/** An error with its frames: the error is the title and opening it shows the stack. */
export function StackTrace({ text }: { text: string }) {
  const [error, ...frames] = text
    .trim()
    .split("\n")
    .map((l) => l.trim());
  const title = error.startsWith("Traceback") ? (frames[frames.length - 1] ?? error) : error;
  return (
    <Trace className="my-2">
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine status="error">
            <TraceIcon>
              <CircleX />
            </TraceIcon>
            <TraceTitle className="truncate">Failed: {title}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <p className="break-words text-destructive">{title}</p>
          <ol className="mt-1 space-y-0.5 font-mono text-xs">
            {frames.slice(0, 40).map((f, i) => (
              <li key={i} className="break-all">
                {f}
              </li>
            ))}
          </ol>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
