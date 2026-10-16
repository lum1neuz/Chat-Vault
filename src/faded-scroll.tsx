import { useEffect, useRef, useState, type ReactNode } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

/**
 * A shadcn scroll area whose top and bottom edges fade out while there is more to scroll. The top fade
 * only shows once you have scrolled down, so the first row at the top stays fully clear.
 */
export function FadedScroll({ className, children, fadeTop = true }: { className?: string; children: ReactNode; fadeTop?: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [top, setTop] = useState(false);
  const [bottom, setBottom] = useState(false);

  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>("[data-slot=scroll-area-viewport]");
    if (!el) return;
    const update = () => {
      setTop(el.scrollTop > 8);
      setBottom(el.scrollHeight - el.scrollTop - el.clientHeight > 8);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, []);

  return (
    <div ref={ref} className={cn("relative min-h-0", className)}>
      <ScrollArea className="h-full">{children}</ScrollArea>
      {fadeTop && <div className={cn("pointer-events-none absolute inset-x-0 top-0 z-10 h-8 bg-gradient-to-b from-background to-transparent transition-opacity duration-200", top ? "opacity-100" : "opacity-0")} />}
      <div className={cn("pointer-events-none absolute inset-x-0 bottom-0 z-10 h-12 bg-gradient-to-t from-background to-transparent transition-opacity duration-200", bottom ? "opacity-100" : "opacity-0")} />
    </div>
  );
}
