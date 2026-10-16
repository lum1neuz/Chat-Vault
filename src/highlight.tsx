import { cn } from "@/lib/utils";

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Wraps every match of the in-chat search in a highlight. */
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
