import { useMemo } from "react";
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton, CodeBlockHeader, CodeBlockLine, CodeBlockTitle } from "@/components/ui/code-block";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";
import { cn } from "@/lib/utils";

type Part = { type: "text"; text: string } | { type: "code"; text: string; lang: string };

/** Splits a message into plain text and fenced ```code``` blocks. */
export function splitParts(text: string): Part[] {
  const parts: Part[] = [];
  const re = /```([\w+#.-]*)[^\n]*\n([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push({ type: "text", text: text.slice(last, m.index) });
    parts.push({ type: "code", lang: (m[1] || "text").toLowerCase(), text: m[2].replace(/\n$/, "") });
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < text.length) parts.push({ type: "text", text: text.slice(last) });
  return parts.filter((p) => p.text.trim().length > 0 || p.type === "code");
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function Highlight({ text, q, activeMark }: { text: string; q: string; activeMark: boolean }) {
  if (!q) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escapeRe(q)})`, "ig"));
  let first = true;
  return (
    <>
      {parts.map((p, i) => {
        if (p.toLowerCase() !== q.toLowerCase()) return <span key={i}>{p}</span>;
        const isActive = activeMark && first;
        first = false;
        return (
          <mark key={i} className={cn("rounded px-0.5 text-foreground", isActive ? "bg-primary/40 ring-1 ring-primary" : "bg-yellow-400/40")}>
            {p}
          </mark>
        );
      })}
    </>
  );
}

function Code({ code, lang }: { code: string; lang: string }) {
  const lines = useHighlightedCode(code, lang);
  return (
    <CodeBlock size="sm" className="my-2 w-full text-xs">
      <CodeBlockHeader>
        <CodeBlockTitle>{lang === "text" ? "Code" : lang}</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton value={code} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent lineNumbers={false}>
        {lines.map((line, i) => (
          <CodeBlockLine key={i}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  );
}

/** Message text with code blocks rendered by the shadcn Code Block. */
export function MessageBody({ text, q, active }: { text: string; q: string; active: boolean }) {
  const parts = useMemo(() => splitParts(text), [text]);
  return (
    <div className="min-w-0 space-y-1">
      {parts.map((p, i) =>
        p.type === "code" ? (
          <Code key={i} code={p.text} lang={p.lang} />
        ) : (
          <p key={i} className="whitespace-pre-wrap break-words leading-relaxed">
            <Highlight text={p.text.replace(/^\n+|\n+$/g, "")} q={q} activeMark={active} />
          </p>
        ),
      )}
    </div>
  );
}
