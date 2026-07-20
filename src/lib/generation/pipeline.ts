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
    blocks = await generateNoteBody(engine, combined, language);
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
