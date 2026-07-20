import { useEffect, useRef, useState } from "react";
import { ArrowUp, Paperclip, X } from "lucide-react";
import { useApp } from "../lib/app";
import { chatAnswer } from "../lib/generation";
import { ingest } from "../lib/ingest";
import { renderMarkdown } from "../lib/markdown";
import { uuid, now } from "../lib/ids";
import type { ChatTurn, Note } from "../lib/types";

interface Attachment {
  name: string;
  text: string;
}

/* Route a picked file to the right ingest extractor. Chat context is
   text-only, so audio/images aren't accepted here. */
async function fileToAttachment(file: File): Promise<Attachment> {
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") {
    return { name: file.name, text: (await ingest({ kind: "pdf", file, filename: file.name })).text };
  }
  if (ext === "docx") {
    return { name: file.name, text: (await ingest({ kind: "docx", file, filename: file.name })).text };
  }
  if (["txt", "md", "markdown", "text"].includes(ext) || file.type.startsWith("text/")) {
    return { name: file.name, text: await file.text() };
  }
  throw new Error(`Can't read "${file.name}". Attach a PDF, DOCX, TXT, or Markdown file.`);
}

/* Shared chat surface. `hero` = the full-page chat view; `panel` = the editor's
   collapsible side assistant. Streams tokens live and persists both turns. */
export default function Assistant({
  note,
  variant,
}: {
  note: Note;
  variant: "hero" | "panel";
}) {
  const { repo, engine } = useApp();
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    repo?.chatFor(note.id).then(setTurns);
  }, [repo, note.id]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns, streaming]);

  async function send(question: string, attachments: Attachment[] = []) {
    if (!question.trim() || busy) return;
    setErr(null);
    if (!engine) {
      setErr("Set up your engine in Settings first (pick Local or add a key).");
      return;
    }
    /* The turn we store/show is what the user typed plus a chip line naming any
       attachments; the model additionally receives the attached text inline. */
    const displayContent = attachments.length
      ? `${question.trim()}\n\n${attachments.map((a) => `📎 ${a.name}`).join("  ")}`
      : question.trim();
    const modelQuestion = attachments.length
      ? `The user attached ${attachments.length} document(s) for you to use as context:\n\n` +
        attachments.map((a) => `--- ${a.name} ---\n${a.text}`).join("\n\n") +
        `\n\n---\n\nTheir question: ${question.trim()}`
      : question.trim();
    const userTurn: ChatTurn = {
      id: uuid(),
      noteId: note.id,
      role: "user",
      content: displayContent,
      at: now(),
    };
    const history = [...turns];
    setTurns([...history, userTurn]);
    await repo?.putChat(userTurn);
    setBusy(true);
    setStreaming("");
    try {
      let acc = "";
      const full = await chatAnswer(engine, note, history, modelQuestion, (d) => {
        acc += d;
        setStreaming(acc);
      });
      const asst: ChatTurn = {
        id: uuid(),
        noteId: note.id,
        role: "assistant",
        content: full || acc,
        at: now(),
      };
      await repo?.putChat(asst);
      setTurns((t) => [...t, asst]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setStreaming(null);
      setBusy(false);
    }
  }

  const hasConversation = turns.length > 0 || streaming !== null;

  return (
    <div className="flex h-full flex-col">
      {variant === "hero" && !hasConversation ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-6 px-8">
          <div className="text-center">
            <h1 className="font-display text-5xl font-bold">Hey, I'm Nitro</h1>
            <p className="mt-3 text-lg text-ink-dim">
              Ask me anything about the source material.
            </p>
          </div>
          <div className="w-full max-w-2xl">
            <ChatInput onSend={send} busy={busy} />
          </div>
        </div>
      ) : variant === "panel" && !hasConversation ? (
        <>
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
            <h2 className="font-display text-3xl font-bold">Hey, I'm Nitro</h2>
            <p className="text-ink-dim">
              I can work with you on your doc and answer any questions!
            </p>
          </div>
          <div className="p-4">
            {err && <p className="mb-2 text-xs font-semibold text-danger-ink">{err}</p>}
            <ChatInput onSend={send} busy={busy} />
          </div>
        </>
      ) : (
        <>
          <div
            ref={scrollRef}
            className={`flex-1 space-y-4 overflow-y-auto ${
              variant === "hero" ? "px-8 py-6" : "p-4"
            }`}
          >
            <div className={variant === "hero" ? "mx-auto max-w-2xl space-y-4" : "space-y-4"}>
              {turns.map((t) => (
                <Bubble key={t.id} turn={t} />
              ))}
              {streaming !== null && (
                <Bubble
                  turn={{
                    id: "stream",
                    noteId: note.id,
                    role: "assistant",
                    content: streaming || "…",
                    at: 0,
                  }}
                />
              )}
            </div>
          </div>
          <div className={variant === "hero" ? "mx-auto w-full max-w-2xl px-8 pb-6" : "p-4"}>
            {err && <p className="mb-2 text-xs font-semibold text-danger-ink">{err}</p>}
            <ChatInput onSend={send} busy={busy} />
          </div>
        </>
      )}
    </div>
  );
}

function Bubble({ turn }: { turn: ChatTurn }) {
  if (turn.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl bg-accent px-4 py-2.5 text-sm text-white">
          {turn.content}
        </div>
      </div>
    );
  }
  return (
    <div
      className="prose-nitro max-w-none text-sm leading-relaxed text-ink"
      dangerouslySetInnerHTML={{ __html: renderMarkdown(turn.content) }}
    />
  );
}

function ChatInput({
  onSend,
  busy,
}: {
  onSend: (q: string, attachments: Attachment[]) => void;
  busy: boolean;
}) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function submit() {
    if ((!value.trim() && attachments.length === 0) || busy) return;
    if (!value.trim()) return; // need a question alongside any attachments
    onSend(value, attachments);
    setValue("");
    setAttachments([]);
    setAttachError(null);
  }

  async function onPickFiles(files: FileList | null) {
    if (!files?.length) return;
    setAttachError(null);
    setAttaching(true);
    try {
      const added: Attachment[] = [];
      for (const file of Array.from(files)) {
        try {
          added.push(await fileToAttachment(file));
        } catch (e) {
          setAttachError(e instanceof Error ? e.message : `Couldn't read ${file.name}.`);
        }
      }
      if (added.length) setAttachments((a) => [...a, ...added]);
    } finally {
      setAttaching(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="rounded-2xl border border-edge bg-card p-3 shadow-soft">
      {(attachments.length > 0 || attachError) && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {attachments.map((a, i) => (
            <span
              key={i}
              className="flex items-center gap-1 rounded-lg bg-accent-softer px-2 py-1 text-xs text-ink-dim"
            >
              <Paperclip className="size-3" />
              <span className="max-w-[160px] truncate">{a.name}</span>
              <button
                onClick={() => setAttachments((list) => list.filter((_, j) => j !== i))}
                className="hover:text-ink"
                aria-label={`Remove ${a.name}`}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          {attachError && <span className="text-xs text-danger-ink">{attachError}</span>}
        </div>
      )}
      <textarea
        rows={1}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="Type a question here or type '@' to reference documents..."
        className="w-full resize-none bg-transparent px-1 py-1 text-sm outline-none placeholder:text-ink-faint"
      />
      <input
        ref={fileRef}
        type="file"
        accept=".pdf,.docx,.txt,.md,.markdown,text/*"
        multiple
        hidden
        onChange={(e) => void onPickFiles(e.target.files)}
      />
      <div className="mt-2 flex items-center justify-between">
        <button
          onClick={() => fileRef.current?.click()}
          disabled={attaching}
          className="p-1.5 text-accent hover:opacity-80 disabled:opacity-50"
          aria-label="Attach a document"
          title="Attach a PDF, DOCX, TXT, or Markdown file"
        >
          <Paperclip className="size-4.5" />
        </button>
        <div className="flex items-center gap-2">
          <button
            onClick={submit}
            disabled={busy}
            className="rounded-xl bg-accent-softer p-2 text-ink-dim hover:text-ink disabled:opacity-50"
            aria-label="Send"
          >
            <ArrowUp className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
