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

export type EngineMode = "local" | "cloud";
export type Provider = "openai" | "anthropic";

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
  blocks: Block[];
  folderId?: ID;
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

export interface Folder {
  id: ID;
  name: string;
  createdAt: number;
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

export type QuizType = "mcq" | "true_false" | "fill_blank";

export interface QuizQuestion {
  id: ID;
  noteId: ID;
  type: QuizType;
  topic: string;
  difficulty: "basic" | "intermediate" | "exam";
  question: string;
  options: string[]; // mcq / true_false
  correctIndex: number; // index into options; for fill_blank, 0 and options[0] is the answer
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
  createdAt: number;
}

/* ---- Chat --------------------------------------------------------------- */

export interface ChatTurn {
  id: ID;
  noteId: ID;
  role: "user" | "assistant";
  content: string;
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
  /* Per-mode model selection; empty string = provider/engine default. */
  cloudModel?: string;
  localModel?: string;
  language: string;
}
