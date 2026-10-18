import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { notify, notifyError } from "@/toast";
import { Check, ChevronLeft, ChevronRight, Copy, Download, Maximize2, X, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Every picture in the open chat, so the viewer can slide between them. */
export const GalleryContext = createContext<{ images: string[]; open: (src: string) => void }>({ images: [], open: () => {} });

const ext = (src: string) => {
  const m = /^data:image\/([a-z0-9+.-]+)/i.exec(src);
  const t = (m?.[1] || "png").toLowerCase();
  return t === "jpeg" ? "jpg" : t.replace("svg+xml", "svg");
};

/** Opens the system Save dialog and writes the picture where the user chooses. */
export async function downloadImage(src: string, n: number) {
  const type = ext(src);
  try {
    const path = await save({ defaultPath: `chatvault-image-${n}.${type}`, filters: [{ name: "Image", extensions: [type] }] });
    if (!path) return;
    const bytes = new Uint8Array(await (await fetch(src)).arrayBuffer());
    await invoke("write_image_file", { path, bytes: Array.from(bytes) });
    notify("Image saved");
  } catch (e) {
    notifyError(e);
  }
}

/** Copies the picture itself (as PNG), so it can be pasted into other apps. */
export async function copyImage(src: string) {
  const img = new Image();
  img.src = src;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext("2d")?.drawImage(img, 0, 0);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
  if (!blob) throw new Error("copy failed");
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

function IconBtn({ label, onClick, children, className }: { label: string; onClick: () => void; children: ReactNode; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon" className={cn("size-8 text-white/80 hover:bg-white/15 hover:text-white", className)} aria-label={label} onClick={onClick} />}>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function useCopied() {
  const [copied, setCopied] = useState(false);
  const run = (src: string) =>
    copyImage(src)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      })
      .catch(() => {});
  return [copied, run] as const;
}

/** A picture in the conversation, with actions that appear on hover. */
export function ChatImage({ src }: { src: string }) {
  const g = useContext(GalleryContext);
  const [copied, copy] = useCopied();
  const n = Math.max(1, g.images.indexOf(src) + 1);
  return (
    <div className="group/img relative inline-block max-w-full overflow-hidden rounded-xl border bg-muted/30 shadow-sm">
      <button type="button" onClick={() => g.open(src)} className="block cursor-zoom-in" aria-label="Open image">
        <img src={src} alt="Chat attachment" loading="lazy" className="block max-h-80 max-w-full object-contain" />
      </button>
      <div className="absolute right-2 top-2 flex gap-1 rounded-lg bg-black/60 p-1 opacity-0 backdrop-blur transition-opacity focus-within:opacity-100 group-hover/img:opacity-100">
        <IconBtn label="Open full screen" onClick={() => g.open(src)}>
          <Maximize2 className="size-4" />
        </IconBtn>
        <IconBtn label={copied ? "Copied" : "Copy image"} onClick={() => copy(src)}>
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </IconBtn>
        <IconBtn label="Download" onClick={() => downloadImage(src, n)}>
          <Download className="size-4" />
        </IconBtn>
      </div>
      {g.images.length > 1 && (
        <span className="absolute bottom-2 left-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] tabular-nums text-white/90 backdrop-blur">
          {n} / {g.images.length}
        </span>
      )}
    </div>
  );
}

/** Full-screen viewer: arrow keys or the side buttons slide between the chat's pictures, Esc closes. */
export function Lightbox({ images, index, onIndex, onClose }: { images: string[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const [zoom, setZoom] = useState(false);
  const [copied, copy] = useCopied();
  const many = images.length > 1;
  const go = useCallback((d: number) => onIndex((index + d + images.length) % images.length), [index, images.length, onIndex]);

  useEffect(() => setZoom(false), [index]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
      if (many && e.key === "ArrowRight") go(1);
      if (many && e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [go, many, onClose]);

  const src = images[index];
  if (!src) return null;
  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-black/90 backdrop-blur-sm" role="dialog" aria-label="Image viewer">
      <div className="flex items-center justify-between px-4 py-3 text-white">
        <span className="text-sm tabular-nums text-white/70">{many ? `${index + 1} / ${images.length}` : "Image"}</span>
        <div className="flex items-center gap-1">
          <IconBtn label={zoom ? "Fit to screen" : "Actual size"} onClick={() => setZoom((z) => !z)}>
            {zoom ? <ZoomOut className="size-4" /> : <ZoomIn className="size-4" />}
          </IconBtn>
          <IconBtn label={copied ? "Copied" : "Copy image"} onClick={() => copy(src)}>
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          </IconBtn>
          <IconBtn label="Download" onClick={() => downloadImage(src, index + 1)}>
            <Download className="size-4" />
          </IconBtn>
          <IconBtn label="Close" onClick={onClose}>
            <X className="size-4" />
          </IconBtn>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        <div className={cn("flex size-full p-4", zoom ? "overflow-auto" : "items-center justify-center")} onClick={(e) => e.target === e.currentTarget && onClose()}>
          <img
            key={src}
            src={src}
            alt="Chat attachment"
            onClick={() => setZoom((z) => !z)}
            className={cn("m-auto select-none rounded-lg shadow-2xl", zoom ? "max-w-none cursor-zoom-out" : "max-h-full max-w-full cursor-zoom-in object-contain")}
          />
        </div>
        {many && (
          <>
            <Button variant="ghost" size="icon" className="absolute left-3 top-1/2 size-10 -translate-y-1/2 rounded-full bg-black/40 text-white hover:bg-white/20 hover:text-white" aria-label="Previous image" onClick={() => go(-1)}>
              <ChevronLeft className="size-5" />
            </Button>
            <Button variant="ghost" size="icon" className="absolute right-3 top-1/2 size-10 -translate-y-1/2 rounded-full bg-black/40 text-white hover:bg-white/20 hover:text-white" aria-label="Next image" onClick={() => go(1)}>
              <ChevronRight className="size-5" />
            </Button>
          </>
        )}
      </div>

    </div>
  );
}
