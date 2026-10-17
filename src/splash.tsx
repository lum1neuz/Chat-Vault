import { AppLogo } from "@/claude-logo";
import { cn } from "@/lib/utils";

/** Shown while ChatVault starts: just the logo, so the list never flashes its skeleton on the first load. */
export function Splash({ leaving }: { leaving: boolean }) {
  return (
    <div
      className={cn("fixed inset-0 z-[70] flex flex-col items-center justify-center gap-4 bg-background transition-opacity duration-300", leaving ? "pointer-events-none opacity-0" : "opacity-100")}
      aria-busy="true"
      aria-label="Starting ChatVault"
    >
      <AppLogo className="size-16 animate-pulse rounded-2xl shadow-lg ring-1 ring-border" />
      <p className="text-sm text-muted-foreground">Getting your chats ready…</p>
    </div>
  );
}
