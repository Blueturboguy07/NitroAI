/* NitroAI domain model — shared contract for db, engine, generation, and UI.
   Everything persisted lives here. IDs are uuid strings. Timestamps are epoch ms. */

export type ID = string;

export type SourceKind =
  | "blank"
  | "text"
  | "pdf"
  | "docx"
  | "audio"
  | "youtube"
  | "url";

/* "publik" = the metered publik API, provisioned by the app itself;
   "cloud" = the user's own key, unchanged. */
export type EngineMode = "local" | "cloud" | "publik";
export type Provider = "openai" | "anthropic" | "gemini" | "publik";

/* The models a cloud provider runs. "strong" carries notes, flashcards,
   quizzes and podcast scripts; "fast" carries chat, titles and topic lists.
   Empty / missing = the provider's default. */
export interface ModelChoice {
  fast?: string;
  strong?: string;
}

/* ---- Notes & content ---------------------------------------------------- */

/* A note is one study document. Its body is an ordered list of blocks
   (our editor model, serializable to/from Markdown). */
export interface Note {
  id: ID;
  title: string;
  sourceKind: SourceKind;
  /* Raw normalized source text (transcript / extracted document text). Used as
     grounding context for chat, flashcards, quiz, and podcast generation. */
  sourceText: string;
  /* Optional origin metadata (url, filename, duration). */
  sourceMeta?: Record<string, string | number | undefined>;
  /* Names of every uploaded file the note was generated from, in upload
     order (only files that were read successfully). Missing on notes made
     before this existed and on link/blank notes. */
  sourceFiles?: string[];
  blocks: Block[];
  /* The editor's rich document (Tiptap JSON): highlights, colours, alignment,
     equations. When present it is the source of truth and `blocks` is derived
     from it on every save; notes without it open from `blocks`. */
  doc?: EditorDoc;
  folderId?: ID;
  pinned?: boolean;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
}

export type BlockType =
  | "heading1"
  | "heading2"
  | "heading3"
  | "paragraph"
  | "bullet"
  | "numbered"
  | "todo"
  | "quote"
  | "callout"
  | "code"
  | "math"
  | "divider"
  | "table";

export interface Block {
  id: ID;
  type: BlockType;
  /* Inline markdown text for text blocks; language for code; latex for math. */
  text: string;
  checked?: boolean; // todo
  emoji?: string; // callout / heading marker
  language?: string; // code
  rows?: string[][]; // table
}

/* Serialized editor document (ProseMirror/Tiptap JSON). */
export interface EditorDoc {
  type: string;
  content?: EditorDoc[];
  [key: string]: unknown;
}

/* Folders nest via parentId (missing = top level). `color` is a key from
   FOLDER_COLORS in lib/library.ts; missing on a subfolder = inherit the
   parent's. `order` sorts siblings (lower first, then name). */
export interface Folder {
  id: ID;
  name: string;
  createdAt: number;
  parentId?: ID;
  color?: string;
  order?: number;
}

/* ---- Study tools -------------------------------------------------------- */

export interface Flashcard {
  id: ID;
  noteId: ID;
  front: string;
  back: string;
  topic: string;
  /* FSRS scheduling state. */
  due: number; // epoch ms when next due
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  lastReview?: number;
  state: "new" | "learning" | "review" | "relearning";
}

export type QuizType = "mcq" | "true_false" | "fill_blank" | "short_answer";

export interface QuizQuestion {
  id: ID;
  noteId: ID;
  type: QuizType;
  topic: string;
  difficulty: "basic" | "intermediate" | "exam";
  question: string;
  options: string[]; // mcq / true_false
  /* Index into options. For fill_blank and short_answer it is 0 and
     options[0] is the answer (the model answer, for short_answer) — it arrives
     with the question, so revealing it needs no second request. */
  correctIndex: number;
  explanation: string;
}

export interface QuizAttempt {
  id: ID;
  noteId: ID;
  questionId: ID;
  topic: string;
  correct: boolean;
  at: number;
}

/* ---- Podcast ------------------------------------------------------------ */

export interface PodcastLine {
  speaker: "host" | "guest";
  /* Display text (original). */
  text: string;
  /* Pronunciation-normalized text actually sent to TTS. */
  spoken: string;
}

export interface Podcast {
  id: ID;
  noteId: ID;
  length: "short" | "medium" | "long";
  script: PodcastLine[];
  /* Object URL / data URL / file path of rendered audio, when available. */
  audioUrl?: string;
  /* MIME type of that audio — "audio/mpeg" (OpenAI) or "audio/wav" (Gemini).
     Missing on podcasts recorded before Gemini voices existed (all MP3). */
  audioType?: string;
  createdAt: number;
}

/* ---- Chat --------------------------------------------------------------- */

export interface ChatTurn {
  id: ID;
  noteId: ID;
  role: "user" | "assistant";
  content: string;
  /* Passage the user highlighted in the document and asked about. */
  quote?: string;
  at: number;
}

/* ---- Job pipeline ------------------------------------------------------- */

export type JobStage =
  | "ingest"
  | "transcribe"
  | "notes"
  | "title"
  | "flashcards"
  | "quiz"
  | "podcast";

export type JobStatus = "queued" | "running" | "done" | "error";

export interface JobFile {
  name: string;
  status: JobStatus;
  error?: string;
}

export interface Job {
  id: ID;
  noteId?: ID;
  label: string;
  stage: JobStage;
  status: JobStatus;
  progress: number; // 0..1
  message: string;
  files?: JobFile[]; // per-file status for multi-upload
  error?: string;
  createdAt: number;
  updatedAt: number;
}

/* ---- Engine preferences ------------------------------------------------- */

export interface EnginePrefs {
  /* null until the user makes an explicit choice at onboarding — NO default. */
  mode: EngineMode | null;
  onboarded: boolean;
  /* Per-mode model selection; empty string = provider/engine default.
     `cloudModel` is the legacy single override (both tiers, any provider);
     `cloudModels` is what Settings writes, kept per provider so switching
     keys never sends one provider's model id to another. */
  cloudModel?: string;
  cloudModels?: Partial<Record<Provider, ModelChoice>>;
  /* Which provider the "My own key" key belongs to; empty = detect from the
     key's prefix. */
  cloudProvider?: Provider | "";
  localModel?: string;
  language: string;
  /* The publik API disclosure_version the user accepted; 0 = never shown. */
  publikDisclosureAck?: number;
}
