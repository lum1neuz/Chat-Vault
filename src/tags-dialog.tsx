import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Tag, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { Chat } from "@/chat-actions";

/** Your own labels for a chat. They live in ChatVault only and show up as filters in the sidebar menu. */
export function TagsDialog({ chat, suggestions, onClose, onSaved }: { chat: Chat | null; suggestions: string[]; onClose: () => void; onSaved: () => void }) {
  const [tags, setTags] = useState<string[]>([]);
  const [text, setText] = useState("");
  useEffect(() => {
    setText("");
    setTags([]);
    if (chat) void invoke<string[]>("chat_tags", { provider: chat.provider, id: chat.id }).then(setTags).catch(() => {});
  }, [chat?.id, chat?.provider]);

  const add = (t: string) => {
    const clean = t.replace(/[^\p{L}\p{N} -]/gu, "").trim().slice(0, 30);
    if (clean && !tags.some((x) => x.toLowerCase() === clean.toLowerCase())) setTags([...tags, clean]);
    setText("");
  };
  const save = async () => {
    if (!chat) return;
    const all = text.trim() ? [...tags, text.trim()] : tags;
    await invoke("set_chat_tags", { provider: chat.provider, id: chat.id, tags: all });
    onSaved();
    onClose();
  };

  return (
    <Dialog open={!!chat} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
              <Tag className="size-4 text-muted-foreground" strokeWidth={1.5} />
            </div>
            <div className="min-w-0">
              <DialogTitle className="text-base font-medium">Tags</DialogTitle>
              <DialogDescription>Only shown in ChatVault. Use them to filter your list.</DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <div className="flex flex-wrap gap-1.5">
          {tags.map((t) => (
            <Badge key={t} variant="secondary" className="h-6 gap-1 pr-1">
              {t}
              <button aria-label={`Remove ${t}`} className="cursor-pointer rounded p-0.5 hover:bg-background/60" onClick={() => setTags(tags.filter((x) => x !== t))}>
                <X className="size-3" />
              </button>
            </Badge>
          ))}
          {!tags.length && <p className="text-sm text-muted-foreground">No tags yet.</p>}
        </div>
        <Input
          value={text}
          autoFocus
          placeholder="Type a tag and press Enter"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add(text);
            }
          }}
        />
        {suggestions.filter((s) => !tags.includes(s)).length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {suggestions.filter((s) => !tags.includes(s)).slice(0, 8).map((s) => (
              <button key={s} className="cursor-pointer rounded-md border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted" onClick={() => add(s)}>
                + {s}
              </button>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
