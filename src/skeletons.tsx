import { Skeleton } from "@/components/ui/skeleton";

const W = ["w-3/4", "w-2/3", "w-5/6", "w-1/2", "w-4/5", "w-3/5"];

/** One chat row: logo box, title, project and date. */
export function ChatRowSkeleton({ i = 0 }: { i?: number }) {
  return (
    <div className="flex items-start gap-2.5 px-2.5 py-2">
      <Skeleton className="mt-0.5 size-8 shrink-0 rounded-lg" />
      <div className="min-w-0 flex-1 space-y-1.5 py-0.5">
        <Skeleton className={`h-3.5 ${W[i % W.length]}`} />
        <div className="flex items-center gap-1.5">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="size-1 rounded-full" />
          <Skeleton className="h-3 w-24" />
        </div>
      </div>
    </div>
  );
}

export function SidebarSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="space-y-0.5" aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <ChatRowSkeleton key={i} i={i} />
      ))}
    </div>
  );
}

function BubbleSkeleton({ right, lines }: { right?: boolean; lines: number }) {
  return (
    <div className={`flex ${right ? "justify-end" : ""}`}>
      <div className={`space-y-2 rounded-xl border px-3.5 py-3 ${right ? "w-[55%]" : "w-[78%]"}`}>
        <div className="flex items-center gap-2">
          <Skeleton className="h-3 w-10" />
          <Skeleton className="h-3 w-12" />
        </div>
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton key={i} className={`h-3.5 ${i === lines - 1 ? "w-2/5" : i % 2 ? "w-11/12" : "w-full"}`} />
        ))}
      </div>
    </div>
  );
}

/** Messages while a chat is loading. */
export function MessagesSkeleton() {
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4" aria-busy="true">
      <BubbleSkeleton right lines={2} />
      <BubbleSkeleton lines={5} />
      <div className="flex items-center gap-2 pl-2">
        <Skeleton className="size-3" />
        <Skeleton className="h-3 w-56" />
      </div>
      <BubbleSkeleton right lines={3} />
      <BubbleSkeleton lines={4} />
      <BubbleSkeleton right lines={1} />
    </div>
  );
}

/** The chat header while a chat is loading. */
export function HeaderSkeleton() {
  return (
    <div className="border-b py-3" aria-busy="true">
      <div className="w-full space-y-3 px-4">
      <div className="flex items-center gap-3">
        <Skeleton className="size-9 rounded-lg" />
        <Skeleton className="h-5 w-64" />
        <div className="ml-auto flex gap-2">
          <Skeleton className="size-8" />
          <Skeleton className="size-8" />
          <Skeleton className="size-8" />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-8 w-24" />
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Skeleton className="h-5 w-24 rounded-full" />
        <Skeleton className="h-5 w-40 rounded-full" />
        <Skeleton className="h-5 w-28 rounded-full" />
        <Skeleton className="h-4 w-52" />
      </div>
      </div>
    </div>
  );
}

export function StatSkeleton() {
  return <Skeleton className="h-4 w-12" />;
}
