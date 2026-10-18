import { createContext, useContext, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, Copy, ExternalLink, File as FileIcon, FileAudio, FileCode2, FileImage, FileText, FileVideo, FolderOpen, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CodeBlock, CodeBlockContent, CodeBlockLine } from "@/components/ui/code-block";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";
import { fmtSize } from "@/chat-actions";
import { notifyError } from "@/toast";

type FileData = { path: string; content: string; size: number; truncated: boolean; modifiedMs: number | null };
type FileInfo = { path: string; size: number; kind: "text" | "image" | "video" | "audio" | "pdf" | "other"; ext: string; modifiedMs: number | null };

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/mp4", ogv: "video/ogg",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", opus: "audio/ogg",
  pdf: "application/pdf",
};

/** Loads a picture, video, sound or PDF from disk and gives back a URL the page can show, cleaned up when the file changes. */
function useMediaUrl(info: FileInfo | null, base: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    setErr(null);
    if (!info || !["image", "video", "audio", "pdf"].includes(info.kind)) return;
    let stale = false;
    let made: string | null = null;
    invoke<ArrayBuffer>("read_file_bytes", { path: info.path, base })
      .then((buf) => {
        if (stale) return;
        made = URL.createObjectURL(new Blob([buf], { type: MIME[info.ext] ?? "application/octet-stream" }));
        setUrl(made);
      })
      .catch((e) => {
        if (stale) return;
        setErr(String(e));
        notifyError(e);
      });
    return () => {
      stale = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [info, base]);
  return { url, err };
}

const KIND_ICON = { text: FileCode2, image: FileImage, video: FileVideo, audio: FileAudio, pdf: FileText, other: FileIcon } as const;

export const FileViewContext = createContext<{ base: string | null; open: (path: string) => void }>({ base: null, open: () => {} });
export const useFileView = () => useContext(FileViewContext);

/** File types that count as a file name even without a folder in front of them, like `report.pdf` or `chatvault-image-1.png`. */
const KNOWN =
  "tsx?|jsx?|mjs|cjs|json|jsonc|md|mdx|css|scss|sass|less|html?|php|py|pyw|rs|go|java|kt|kts|swift|vue|svelte|astro|ya?ml|toml|sql|sh|bash|zsh|ps1|psm1|bat|cmd|txt|env|lock|xml|svg|c|cc|cpp|h|hpp|cs|rb|lua|dart|scala|r|pl|ex|exs|hs|zig|csv|tsv|log|ini|cfg|conf|properties|gradle|map|" +
  "png|jpe?g|gif|webp|bmp|ico|avif|tiff?|heic|psd|ai|fig|" +
  "mp4|webm|mov|m4v|mkv|avi|wmv|ogv|mp3|wav|ogg|oga|m4a|aac|flac|opus|" +
  "pdf|docx?|xlsx?|pptx?|odt|ods|rtf|epub|zip|rar|7z|gz|tgz|tar|iso|exe|dll|msi|jar|apk|dmg|bin|db|sqlite|ttf|otf|woff2?|pem|crt|key";
const NAMED = new RegExp(`\\.(?:${KNOWN})(?::\\d+(?:-\\d+)?)?$`, "i");

/** Looks like a file path: a folder-style path or a name with a known file type, optionally followed by :line. */
export function isFilePath(text: string) {
  const t = text.trim();
  if (t.length < 3 || t.length > 260 || /\s/.test(t) || /^https?:/i.test(t)) return false;
  return /^(?:[A-Za-z]:)?[\w@.~\\/-]*[\w@-]\.[A-Za-z0-9]{1,8}(?::\d+(?:-\d+)?)?$/.test(t) && (/[\\/]/.test(t) || NAMED.test(t));
}

const LANG: Record<string, string> = { ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript", json: "json", md: "markdown", css: "css", scss: "css", html: "html", htm: "html", py: "python", sh: "bash", ps1: "bash", yml: "yaml", yaml: "yaml", sql: "sql", php: "text", rs: "text", go: "text", vue: "html", svelte: "html" };
const langOf = (p: string) => LANG[(p.split(".").pop() || "").toLowerCase()] ?? "text";

function Code({ code, lang }: { code: string; lang: string }) {
  const lines = useHighlightedCode(code, lang);
  return (
    <CodeBlock size="sm" className="min-h-0 flex-1">
      <CodeBlockContent data-lenis-prevent lineNumbers className="max-h-[68vh]">
        {lines.map((line, i) => (
          <CodeBlockLine key={i}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  );
}

/** A look at a file a chat mentioned: code with colours, pictures, video, sound and PDFs shown right here. Anything else can be opened or shown in its folder. */
export function FileViewer({ path, base, hints, onClose }: { path: string | null; base: string | null; hints?: string[]; onClose: () => void }) {
  const [info, setInfo] = useState<FileInfo | null>(null);
  const [data, setData] = useState<FileData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"path" | "text" | null>(null);
  const media = useMediaUrl(info, base);

  useEffect(() => {
    setInfo(null);
    setData(null);
    setError(null);
    if (!path) return;
    let stale = false;
    invoke<FileInfo>("file_info", { path, base, hints: hints ?? [] })
      .then(async (i) => {
        if (stale) return;
        setInfo(i);
        if (i.kind === "text") {
          const d = await invoke<FileData>("read_text_file", { path: i.path, base });
          if (!stale) setData(d);
        }
      })
      .catch((e) => {
        if (stale) return;
        // Nothing to show: tell the user with a toast instead of opening an empty window.
        notifyError(e);
        onClose();
      });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, base]);

  const copy = async (what: "path" | "text", value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      window.setTimeout(() => setCopied(null), 1400);
    } catch {
      /* clipboard can be blocked */
    }
  };
  const act = (cmd: "open_file_default" | "reveal_file") => info && invoke(cmd, { path: info.path, base }).catch((e) => notifyError(e));
  const name = (info?.path ?? path ?? "").split(/[\\/]/).pop() ?? "";
  const lines = data ? data.content.split("\n").length : 0;
  const Icon = info ? KIND_ICON[info.kind] : FileCode2;
  const wide = info && (info.kind === "video" || info.kind === "pdf" || info.kind === "image");

  return (
    <Dialog open={!!path} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className={`flex max-h-[90dvh] flex-col gap-3 ${wide ? "sm:max-w-5xl" : "sm:max-w-4xl"}`}>
        <DialogHeader>
          <div className="flex items-start gap-3 pr-6">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
              <Icon className="size-4 text-muted-foreground" strokeWidth={1.5} />
            </div>
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate text-base font-medium">{name || "File"}</DialogTitle>
              <DialogDescription className="truncate font-mono text-xs" title={info?.path}>
                {info?.path ?? path}
              </DialogDescription>
            </div>
            {info && (
              <div className="flex shrink-0 gap-1.5">
                <Button size="sm" variant="outline" onClick={() => void copy("path", info.path)}>
                  {copied === "path" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} Path
                </Button>
                {data && (
                  <Button size="sm" variant="outline" onClick={() => void copy("text", data.content)}>
                    {copied === "text" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} Code
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={() => void act("reveal_file")}>
                  <FolderOpen className="size-3.5" /> Show
                </Button>
              </div>
            )}
          </div>
        </DialogHeader>
        {!info && !error && (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Opening file…
          </div>
        )}
        {info?.kind === "text" && data && (
          <>
            <Code code={data.content} lang={langOf(data.path)} />
            <p className="text-xs text-muted-foreground">
              {lines.toLocaleString()} lines · {fmtSize(data.size)}
              {data.truncated ? " · showing the first 1.5 MB" : ""} · read-only, as the file is now (it may differ from when the chat happened)
            </p>
          </>
        )}
        {info && ["image", "video", "audio", "pdf"].includes(info.kind) && (
          <>
            {!media.url && !media.err && (
              <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Loading {fmtSize(info.size)}…
              </div>
            )}
            {media.url && info.kind === "image" && (
              <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-lg border bg-muted/30 p-3" data-lenis-prevent>
                <img src={media.url} alt={name} className="max-h-[66vh] max-w-full object-contain" />
              </div>
            )}
            {media.url && info.kind === "video" && <video src={media.url} controls className="max-h-[66vh] w-full rounded-lg bg-black" />}
            {media.url && info.kind === "audio" && (
              <div className="flex items-center justify-center rounded-lg border bg-muted/30 p-8">
                <audio src={media.url} controls className="w-full max-w-xl" />
              </div>
            )}
            {media.url && info.kind === "pdf" && <iframe src={media.url} title={name} className="h-[68vh] w-full rounded-lg border bg-white" />}
            <p className="text-xs text-muted-foreground">
              {info.ext.toUpperCase()} · {fmtSize(info.size)} · read-only, as the file is now
            </p>
          </>
        )}
        {info?.kind === "other" && (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <p className="text-sm text-muted-foreground">
              {info.ext ? `${info.ext.toUpperCase()} files` : "This kind of file"} can't be shown here ({fmtSize(info.size)}).
            </p>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void act("open_file_default")}>
                <ExternalLink className="size-3.5" /> Open with default app
              </Button>
              <Button size="sm" variant="outline" onClick={() => void act("reveal_file")}>
                <FolderOpen className="size-3.5" /> Show in folder
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
