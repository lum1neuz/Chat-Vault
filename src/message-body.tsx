import { useMemo } from "react";
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton, CodeBlockHeader, CodeBlockLine, CodeBlockTitle } from "@/components/ui/code-block";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";
import { Linkified, SourcesTrace, STACK_RE, StackTrace, uniqueUrls } from "@/ai-elements";

export { Highlight } from "@/highlight";

type Part = { type: "text"; text: string } | { type: "code"; text: string; lang: string } | { type: "stack"; text: string };

/** Splits plain text into text and error stack traces. */
function splitStacks(text: string): Part[] {
  const out: Part[] = [];
  let last = 0;
  STACK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STACK_RE.exec(text))) {
    const start = m.index + (m[0].length - m[1].length);
    if (start > last) out.push({ type: "text", text: text.slice(last, start) });
    out.push({ type: "stack", text: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}

/** Splits a message into plain text, stack traces and fenced ```code``` blocks. */
export function splitParts(text: string): Part[] {
  const parts: Part[] = [];
  const re = /```([\w+#.-]*)[^\n]*\n([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(...splitStacks(text.slice(last, m.index)));
    parts.push({ type: "code", lang: (m[1] || "text").toLowerCase(), text: m[2].replace(/\n$/, "") });
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < text.length) parts.push(...splitStacks(text.slice(last)));
  return parts.filter((p) => p.text.trim().length > 0 || p.type === "code");
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

/** Message text: code in Code Block, errors in Stack Trace, links as inline citations and a Sources list. */
export function MessageBody({ text, q, active, assistant }: { text: string; q: string; active: boolean; assistant?: boolean }) {
  const parts = useMemo(() => splitParts(text), [text]);
  const urls = useMemo(() => (assistant ? uniqueUrls(text) : []), [assistant, text]);
  return (
    <div className="min-w-0 space-y-1">
      {parts.map((p, i) =>
        p.type === "code" ? (
          <Code key={i} code={p.text} lang={p.lang} />
        ) : p.type === "stack" ? (
          <StackTrace key={i} text={p.text} />
        ) : (
          <p key={i} className="whitespace-pre-wrap break-words leading-relaxed">
            <Linkified text={p.text.replace(/^\n+|\n+$/g, "")} q={q} active={active} />
          </p>
        ),
      )}
      <SourcesTrace urls={urls} />
    </div>
  );
}
