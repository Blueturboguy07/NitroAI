/* Note-creation pipeline: ingest -> (transcribe) -> notes -> title -> persist.
   Emits Job progress and records per-file success/fail (Turbo silently drops
   files 3-5 of a multi-upload; we show every file's status explicitly). Jobs are
   persisted so a crash mid-generation is recoverable on relaunch.

   A PDF/DOCX whose text layer is empty (scanned pages, slides exported as
   images) is read visually by the engine when it can (see ingest/visual);
   otherwise every unreadable source fails with a message naming the file and
   saying what to do — never a bare "no content". */

import type { Engine } from "../engine/types";
import { EngineError } from "../engine/types";
import type { Repo } from "../db";
import type { Job, JobFile, Note, SourceKind } from "../types";
import { uuid, now } from "../ids";
import { ingest, SourceError, type IngestInput } from "../ingest";
import { completeSparseDocument, needsVisualRead } from "../ingest/visual";
import { generateNoteBody, generateTitle } from "./index";

export type ProgressCb = (job: Job) => void;

export interface CreateNoteOptions {
  repo: Repo;
  engine: Engine;
  inputs: IngestInput[];
  language?: string;
  /* Also auto-generate flashcards + quiz after the note (default false; the UI
     generates those lazily when their tab is opened). */
  onProgress?: ProgressCb;
  signal?: AbortSignal;
}

function primaryKind(inputs: IngestInput[]): SourceKind {
  return inputs[0]?.kind ?? "text";
}

/* What a source is called in messages: its file name, its link, or — for
   pasted text — nothing (the message then stands alone). */
function sourceName(input: IngestInput): string | undefined {
  return input.filename || input.url || undefined;
}

/* The message for a source that was read but came back with no text. */
function emptySourceMessage(input: IngestInput): string {
  switch (input.kind) {
    case "pdf":
      return "This PDF has no text in it. Is it blank?";
    case "docx":
      return "This document is empty — there's no text in it.";
    case "text":
      return input.file
        ? "This file is empty — there's no text in it."
        : "There's no text to make notes from — paste some text first.";
    case "url":
      return "That page has no readable text. It may need JavaScript or a sign-in — copy its text and paste it in instead.";
    case "youtube":
      return "No captions or speech were found in this video.";
    case "audio":
      return "No speech was found in this recording. Check that it has sound.";
    default:
      return "There's no text to make notes from.";
  }
}

function abortError(): Error {
  const e = new Error("Cancelled.");
  e.name = "AbortError";
  return e;
}

/* "1 of 3 files couldn't be read: a.pdf (reason)…" for a note that was made
   from the sources that did work, or null when every source was read. */
export function partialFailureMessage(files: JobFile[]): string | null {
  const failed = files.filter((f) => f.status === "error");
  if (failed.length === 0 || failed.length === files.length) return null;
  const list = failed.map((f) => (f.error ? `${f.name} (${f.error})` : f.name)).join("; ");
  const noun = files.length === 1 ? "source" : "sources";
  return `${failed.length} of ${files.length} ${noun} couldn't be read, so this note leaves them out: ${list}`;
}

export interface SourceFailure {
  name?: string;
  error: string;
  fix?: "settings";
}

/* Thrown when none of the sources could be read. The message names the file
   (one source) or counts them (several); `failures` lists each file with its
   reason. Keeps the kind/detail of an underlying EngineError so e.g. a publik
   credit error still renders its top-up link. */
export class SourcesUnreadableError extends EngineError {
  constructor(
    readonly failures: SourceFailure[],
    cause?: unknown,
  ) {
    const first = failures[0];
    const message =
      failures.length === 1
        ? first.name
          ? `Couldn't read “${first.name}”. ${first.error}`
          : first.error
        : `None of the ${failures.length} sources could be read.`;
    const engineErr = cause instanceof EngineError ? cause : undefined;
    super(message, engineErr?.kind ?? "unknown", engineErr?.detail ?? {});
    this.name = "SourcesUnreadableError";
  }

  /* Switching the engine in Settings would fix at least one failure. */
  get fix(): "settings" | undefined {
    return this.failures.some((f) => f.fix === "settings") ? "settings" : undefined;
  }
}

export async function createNoteFromSources(
  opts: CreateNoteOptions,
): Promise<string> {
  const { repo, engine, inputs, language = "English", onProgress } = opts;

  const job: Job = {
    id: uuid(),
    label:
      inputs.length > 1
        ? `${inputs.length} sources`
        : inputs[0]?.filename || inputs[0]?.url || "New note",
    stage: "ingest",
    status: "running",
    progress: 0,
    message: "Reading sources…",
    files: inputs.map<JobFile>((i) => ({
      name: i.filename || i.url || i.kind,
      status: "queued",
    })),
    createdAt: now(),
    updatedAt: now(),
  };

  const emit = async (patch: Partial<Job>) => {
    Object.assign(job, patch, { updatedAt: now() });
    await repo.putJob(job);
    onProgress?.(job);
  };
  await emit({});

  // 1. Ingest + transcribe each source, tracking per-file status.
  const texts: string[] = [];
  const metas: Record<string, string | number | undefined>[] = [];
  const sourceFiles: string[] = [];
  let anyOk = false;
  const failures: SourceFailure[] = [];
  let firstCause: unknown;
  for (let i = 0; i < inputs.length; i++) {
    const file = job.files![i];
    file.status = "running";
    await emit({
      stage: "ingest",
      message: `Processing ${file.name}…`,
      progress: (i + 0.2) / (inputs.length + 1),
    });
    try {
      const res = await ingest(inputs[i]);
      let text = res.text;
      if (res.needsTranscription && res.audio) {
        // Oversized audio is split by the engines themselves (OpenAI past
        // 25 MB, publik past 4 MB, Gemini past 12 MB) — no cap here.
        file.status = "running";
        await emit({ stage: "transcribe", message: `Transcribing ${file.name}…` });
        const tr = await engine.transcribe(res.audio, opts.signal);
        text = tr.text;
      }
      if (needsVisualRead(inputs[i], res)) {
        text = await completeSparseDocument(engine, inputs[i], res, {
          signal: opts.signal,
          onReading: () => emit({ message: `Reading the pages of ${file.name}…` }),
        });
      }
      if (!text.trim() && inputs[i].kind !== "blank") {
        throw new SourceError(emptySourceMessage(inputs[i]));
      }
      texts.push(text);
      if (res.meta) metas.push(res.meta);
      const filename = inputs[i].filename ?? res.meta?.filename;
      if (typeof filename === "string" && filename) sourceFiles.push(filename);
      file.status = "done";
      anyOk = true;
    } catch (err) {
      if (opts.signal?.aborted) {
        await emit({ status: "error", message: "Cancelled.", error: "Cancelled." });
        throw abortError();
      }
      file.status = "error";
      file.error = err instanceof Error ? err.message : "Failed to process.";
      failures.push({
        name: sourceName(inputs[i]),
        error: file.error,
        ...(err instanceof SourceError && err.fix ? { fix: err.fix } : {}),
      });
      firstCause ??= err;
    }
    await emit({ progress: (i + 1) / (inputs.length + 1) });
  }

  if (!anyOk) {
    const error = new SourcesUnreadableError(
      failures.length ? failures : [{ error: "Ingestion failed." }],
      firstCause,
    );
    await emit({ status: "error", message: "None of the sources could be read.", error: error.message });
    throw error;
  }

  const combined = texts.join("\n\n---\n\n");
  if (opts.signal?.aborted) {
    await emit({ status: "error", message: "Cancelled.", error: "Cancelled." });
    throw abortError();
  }

  // 2. Generate the note body (streaming) unless this is a blank note.
  const isBlank = primaryKind(inputs) === "blank" && !combined.trim();
  let blocks: Note["blocks"] = [];
  if (!isBlank) {
    await emit({ stage: "notes", message: "Writing your notes…", progress: 0.75 });
    try {
      blocks = await generateNoteBody(engine, combined, language);
    } catch (e) {
      // Leave no phantom "running" job behind.
      await emit({ status: "error", message: "Couldn't write the notes.", error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
    if (opts.signal?.aborted) {
      await emit({ status: "error", message: "Cancelled.", error: "Cancelled." });
      throw abortError();
    }
  }

  // 3. Title.
  await emit({ stage: "title", message: "Naming the note…", progress: 0.92 });
  let title = "Untitled Document";
  if (!isBlank) {
    try {
      title = await generateTitle(engine, combined);
    } catch {
      /* keep default title */
    }
  }

  // 4. Persist.
  const note: Note = {
    id: uuid(),
    title,
    sourceKind: primaryKind(inputs),
    sourceText: combined,
    sourceMeta: metas[0],
    ...(sourceFiles.length > 0 && { sourceFiles }),
    blocks,
    createdAt: now(),
    updatedAt: now(),
    lastOpenedAt: now(),
  };
  await repo.putNote(note);
  await emit({
    noteId: note.id,
    stage: "notes",
    status: "done",
    progress: 1,
    message: "Done",
  });
  return note.id;
}

/* On relaunch, mark any jobs left "running" as errored so the UI doesn't show a
   phantom spinner. (Real resumption would re-enqueue; we surface the failure.) */
export async function reconcileJobs(repo: Repo): Promise<void> {
  const active = await repo.activeJobs();
  for (const j of active) {
    j.status = "error";
    j.message = "Interrupted — please retry.";
    j.updatedAt = now();
    await repo.putJob(j);
  }
}
