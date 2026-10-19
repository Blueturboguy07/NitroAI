import { useEffect, useRef, useState } from "react";
import { ArrowUp, Paperclip, Quote as QuoteIcon, X } from "lucide-react";
import { useApp } from "../lib/app";
import { describeError, type ShownError } from "../lib/publik";
import { ErrorNotice } from "./PublikNotice";
import { chatAnswer } from "../lib/generation";
import { capTokens, estimateTokens } from "../lib/generation/chunk";
import { ingest } from "../lib/ingest";
import { renderMarkdown } from "../lib/markdown";
import { uuid, now } from "../lib/ids";
import type { ChatTurn, Note } from "../lib/types";

interface Attachment {
  name: string;
  text: string;
  /* True when the text was cut to fit the attachment budget. */
  trimmed?: boolean;
}

/* Attached text rides inline in one chat request, so it is capped: no file
   may exceed ATTACH_TOKENS_PER_FILE, and all attachments of one message
   share ATTACH_TOKENS_TOTAL (keeps a long PDF from blowing the context
   window or a low tokens-per-minute limit). */
const ATTACH_TOKENS_PER_FILE = 8000;
const ATTACH_TOKENS_TOTAL = 16000;

function capAttachment(a: Attachment, maxTokens: number): Attachment {
  if (estimateTokens(a.text) <= maxTokens) return a;
  return { ...a, text: capTokens(a.text, maxTokens), trimmed: true };
}

/* Text highlighted in the editor via "Ask AI". `nonce` changes on every ask,
   so asking about the same passage twice still refocuses the input. */
export interface Quote {
  text: string;
  nonce: number;
}

/* One-click questions offered while a quote is attached. */
const QUOTE_ACTIONS = ["Explain this", "Summarize this", "Give me an example"];

/* Route a picked file to the right ingest extractor. Chat context is
   text-only, so audio/images aren't accepted here. */
async function extractText(file: File): Promise<string> {
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") {
    return (await ingest({ kind: "pdf", file, filename: file.name })).text;
  }
  if (ext === "docx") {
    return (await ingest({ kind: "docx", file, filename: file.name })).text;
  }
  if (["txt", "md", "markdown", "text"].includes(ext) || file.type.startsWith("text/")) {
    return await file.text();
  }
  throw new Error(`Can't read "${file.name}". Attach a PDF, DOCX, TXT, or Markdown file.`);
}

async function fileToAttachment(file: File): Promise<Attachment> {
  const text = (await extractText(file)).trim();
  if (!text) {
    const isPdf = file.name.toLowerCase().endsWith(".pdf");
    throw new Error(
      isPdf
        ? `"${file.name}" has no selectable text — it looks like a scanned PDF (pages are images). Attach a text-based PDF, or create a note from it instead.`
        : `"${file.name}" is empty — there's no text to attach.`,
    );
  }
  return capAttachment({ name: file.name, text }, ATTACH_TOKENS_PER_FILE);
}

/* Shared chat surface. `hero` = the full-page chat view; `panel` = the editor's
   collapsible side assistant. Streams tokens live and persists both turns. */
export default function Assistant({
  note,
  variant,
  quote = null,
  onClearQuote,
}: {
  note: Note;
  variant: "hero" | "panel";
  quote?: Quote | null;
  onClearQuote?: () => void;
}) {
  const { repo, engine } = useApp();
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ShownError | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    repo?.chatFor(note.id).then(setTurns);
  }, [repo, note.id]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns, streaming]);

  async function send(question: string, attachments: Attachment[] = [], quoted?: string) {
    if (!question.trim() || busy) return;
    setErr(null);
    if (!engine) {
      setErr({ message: "Set up your engine in Settings first (pick publik API, Local, or add a key).", action: null });
      return;
    }
    /* The turn we store/show is what the user typed plus a chip line naming any
       attachments; the model additionally receives the attached text inline. */
    const displayContent = attachments.length
      ? `${question.trim()}\n\n${attachments.map((a) => `📎 ${a.name}`).join("  ")}`
      : question.trim();
    // Share the total budget across this message's attachments.
    const perFile = Math.min(
      ATTACH_TOKENS_PER_FILE,
      Math.floor(ATTACH_TOKENS_TOTAL / Math.max(1, attachments.length)),
    );
    const capped = attachments.map((a) => capAttachment(a, perFile));
    const modelQuestion = capped.length
      ? `The user attached ${capped.length} document(s) for you to use as context:\n\n` +
        capped
          .map((a) => `--- ${a.name}${a.trimmed ? " (truncated)" : ""} ---\n${a.text}`)
          .join("\n\n") +
        `\n\n---\n\nTheir question: ${question.trim()}`
      : question.trim();
    const userTurn: ChatTurn = {
      id: uuid(),
      noteId: note.id,
      role: "user",
      content: displayContent,
      ...(quoted ? { quote: quoted } : {}),
      at: now(),
    };
    const history = [...turns];
    setTurns([...history, userTurn]);
    onClearQuote?.();
    await repo?.putChat(userTurn);
    setBusy(true);
    setStreaming("");
    try {
      let acc = "";
      const full = await chatAnswer(engine, note, history, modelQuestion, quoted, (d) => {
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
      setErr(describeError(e));
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
            <ErrorNotice err={err} compact />
            <ChatInput onSend={send} busy={busy} quote={quote} onClearQuote={onClearQuote} />
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
            <ErrorNotice err={err} compact />
            <ChatInput onSend={send} busy={busy} quote={quote} onClearQuote={onClearQuote} />
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
            <ErrorNotice err={err} compact />
            <ChatInput onSend={send} busy={busy} quote={quote} onClearQuote={onClearQuote} />
          </div>
        </>
      )}
    </div>
  );
}

function Bubble({ turn }: { turn: ChatTurn }) {
  if (turn.role === "user") {
    return (
      <div className="flex flex-col items-end gap-1">
        {turn.quote && (
          <div className="line-clamp-3 max-w-[85%] whitespace-pre-line border-l-2 border-accent pl-2.5 text-xs text-ink-dim">
            {turn.quote}
          </div>
        )}
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
  quote,
  onClearQuote,
}: {
  onSend: (q: string, attachments: Attachment[], quoted?: string) => void;
  busy: boolean;
  quote: Quote | null;
  onClearQuote?: () => void;
}) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // A fresh "Ask AI" from the editor puts the caret in the box.
  useEffect(() => {
    if (quote) inputRef.current?.focus();
  }, [quote?.nonce]);

  function submit(question = value) {
    if ((!question.trim() && attachments.length === 0) || busy) return;
    if (!question.trim()) return; // need a question alongside any attachments
    onSend(question, attachments, quote?.text);
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
      const errors: string[] = [];
      for (const file of Array.from(files)) {
        try {
          added.push(await fileToAttachment(file));
        } catch (e) {
          errors.push(e instanceof Error ? e.message : `Couldn't read ${file.name}.`);
        }
      }
      if (errors.length) setAttachError(errors.join(" "));
      if (added.length) setAttachments((a) => [...a, ...added]);
    } finally {
      setAttaching(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="rounded-2xl border border-edge bg-card p-3 shadow-soft">
      {quote && (
        <div className="mb-2 rounded-lg bg-accent-softer p-2">
          <div className="flex items-start gap-1.5 text-xs text-ink-dim">
            <QuoteIcon className="mt-0.5 size-3 shrink-0 text-accent" />
            <span className="line-clamp-3 flex-1 whitespace-pre-line">{quote.text}</span>
            <button onClick={onClearQuote} className="shrink-0 hover:text-ink" aria-label="Remove quoted text">
              <X className="size-3" />
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {QUOTE_ACTIONS.map((q) => (
              <button
                key={q}
                onClick={() => submit(q)}
                disabled={busy}
                className="rounded-md border border-edge bg-card px-2 py-0.5 text-xs font-semibold text-ink-dim hover:text-ink disabled:opacity-50"
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      )}
      {(attachments.length > 0 || attachError) && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {attachments.map((a, i) => (
            <span
              key={i}
              className="flex items-center gap-1 rounded-lg bg-accent-softer px-2 py-1 text-xs text-ink-dim"
            >
              <Paperclip className="size-3" />
              <span className="max-w-[160px] truncate">{a.name}</span>
              {a.trimmed && (
                <span className="text-ink-faint" title="Only the first part of this file fits in one message.">
                  (trimmed)
                </span>
              )}
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
        ref={inputRef}
        rows={1}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={quote ? "Ask about the highlighted text…" : "Ask a question, or attach a document with the paperclip…"}
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
            onClick={() => submit()}
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
