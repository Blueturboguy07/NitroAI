/* Note-creation pipeline: ingest -> (transcribe) -> notes -> title -> persist.
   Emits Job progress and records per-file success/fail (Turbo silently drops
   files 3-5 of a multi-upload; we show every file's status explicitly). Jobs are
   persisted so a crash mid-generation is recoverable on relaunch. */

import type { Engine } from "../engine/types";
import { EngineError } from "../engine/types";
import type { Repo } from "../db";
import type { Job, JobFile, Note, SourceKind } from "../types";
import { uuid, now } from "../ids";
import { ingest, type IngestInput } from "../ingest";
import { cutTitle } from "../ingest/text";
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
  /* Each read source's own name: the file name for an upload, the page or
     video title for a link, the first line for pasted text. The note's title
     falls back to the first one when the AI title fails or is cut. */
  const sourceTitles: string[] = [];
  let anyOk = false;
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
        if (engine.mode === "cloud" && res.audio.size > 24 * 1024 * 1024) {
          throw new Error(
            "This audio is over 24 MB — larger than the cloud transcription limit. " +
              "Use local transcription, or split it into shorter clips.",
          );
        }
        file.status = "running";
        await emit({ stage: "transcribe", message: `Transcribing ${file.name}…` });
        const tr = await engine.transcribe(res.audio, opts.signal);
        text = tr.text;
      }
      if (!text.trim() && inputs[i].kind !== "blank") {
        throw new Error("No readable content found.");
      }
      texts.push(text);
      if (res.meta) metas.push(res.meta);
      const named = res.title?.trim() || (inputs[i].filename ? stripExtension(inputs[i].filename!) : "");
      if (named) sourceTitles.push(cutTitle(named));
      file.status = "done";
      anyOk = true;
    } catch (err) {
      file.status = "error";
      file.error =
        err instanceof EngineError || err instanceof Error
          ? err.message
          : "Failed to process.";
    }
    await emit({ progress: (i + 1) / (inputs.length + 1) });
  }

  if (!anyOk) {
    await emit({
      status: "error",
      message: "None of the sources could be read.",
      error: job.files?.find((f) => f.error)?.error,
    });
    throw new EngineError(job.error || "Ingestion failed.", "unknown");
  }

  const combined = texts.join("\n\n---\n\n");

  // 2. Generate the note body (streaming) unless this is a blank note.
  const isBlank = primaryKind(inputs) === "blank" && !combined.trim();
  let blocks: Note["blocks"] = [];
  if (!isBlank) {
    await emit({ stage: "notes", message: "Writing your notes…", progress: 0.75 });
    try {
      blocks = await generateNoteBody(engine, combined, language);
    } catch (err) {
      // The job says why no note was saved instead of spinning until relaunch.
      const message = err instanceof Error ? err.message : "Could not write the notes.";
      await emit({ status: "error", message, error: message });
      throw err;
    }
  }

  // 3. Title.
  await emit({ stage: "title", message: "Naming the note…", progress: 0.92 });
  let title = "Untitled Document";
  if (!isBlank) {
    try {
      title = await generateTitle(engine, combined);
    } catch {
      /* The title call failed or was cut: name the note after its source
         (the file name), else its first heading. Never "Untitled Document"
         or half a title. */
      title = sourceTitles[0] || firstHeading(blocks) || title;
    }
  }

  // 4. Persist.
  const note: Note = {
    id: uuid(),
    title,
    sourceKind: primaryKind(inputs),
    sourceText: combined,
    sourceMeta: metas[0],
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

function stripExtension(name: string): string {
  return name.replace(/\.[^./\\]+$/, "").trim();
}

/* The text of the note's first heading (H1 first, then H2, then H3). */
function firstHeading(blocks: Note["blocks"]): string {
  for (const type of ["heading1", "heading2", "heading3"] as const) {
    const b = blocks.find((x) => x.type === type && x.text?.trim());
    if (b) return cutTitle(b.text.replace(/\*\*|__/g, ""));
  }
  return "";
}
