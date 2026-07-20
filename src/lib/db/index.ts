/* Storage abstraction. The app uses the IndexedDB implementation; tests use the
   in-memory one. A future Rust/SQLite backend implements the same Store. */

import type {
  ChatTurn,
  Flashcard,
  Folder,
  Job,
  Note,
  Podcast,
  QuizAttempt,
  QuizQuestion,
} from "../types";

/* Collections keyed by id. `by` fields enable cheap filtered reads. */
export interface Store {
  get<T>(collection: string, id: string): Promise<T | undefined>;
  put<T extends { id: string }>(collection: string, value: T): Promise<T>;
  delete(collection: string, id: string): Promise<void>;
  all<T>(collection: string): Promise<T[]>;
  /* Shallow equality filter over top-level fields. */
  where<T>(collection: string, match: Partial<T>): Promise<T[]>;
  clear(collection: string): Promise<void>;
}

export const COLLECTIONS = {
  notes: "notes",
  folders: "folders",
  flashcards: "flashcards",
  quiz: "quiz",
  attempts: "attempts",
  podcasts: "podcasts",
  chat: "chat",
  jobs: "jobs",
} as const;

/* High-level repository over a Store. This is what generation code and the UI
   use; it never touches the raw Store directly. */
export class Repo {
  constructor(private store: Store) {}

  // notes
  getNote = (id: string) => this.store.get<Note>(COLLECTIONS.notes, id);
  putNote = (n: Note) => this.store.put(COLLECTIONS.notes, n);
  deleteNote = async (id: string) => {
    await this.store.delete(COLLECTIONS.notes, id);
    for (const c of [
      COLLECTIONS.flashcards,
      COLLECTIONS.quiz,
      COLLECTIONS.attempts,
      COLLECTIONS.podcasts,
      COLLECTIONS.chat,
    ]) {
      const rows = await this.store.where<{ id: string; noteId: string }>(c, {
        noteId: id,
      } as Partial<{ id: string; noteId: string }>);
      await Promise.all(rows.map((r) => this.store.delete(c, r.id)));
    }
  };
  listNotes = async () =>
    (await this.store.all<Note>(COLLECTIONS.notes)).sort(
      (a, b) => b.lastOpenedAt - a.lastOpenedAt,
    );

  // folders
  listFolders = () => this.store.all<Folder>(COLLECTIONS.folders);
  putFolder = (f: Folder) => this.store.put(COLLECTIONS.folders, f);
  deleteFolder = (id: string) => this.store.delete(COLLECTIONS.folders, id);

  // flashcards
  cardsFor = (noteId: string) =>
    this.store.where<Flashcard>(COLLECTIONS.flashcards, { noteId });
  putCard = (c: Flashcard) => this.store.put(COLLECTIONS.flashcards, c);
  putCards = (cs: Flashcard[]) =>
    Promise.all(cs.map((c) => this.store.put(COLLECTIONS.flashcards, c)));

  // quiz
  questionsFor = (noteId: string) =>
    this.store.where<QuizQuestion>(COLLECTIONS.quiz, { noteId });
  putQuestions = (qs: QuizQuestion[]) =>
    Promise.all(qs.map((q) => this.store.put(COLLECTIONS.quiz, q)));
  attemptsFor = (noteId: string) =>
    this.store.where<QuizAttempt>(COLLECTIONS.attempts, { noteId });
  putAttempt = (a: QuizAttempt) => this.store.put(COLLECTIONS.attempts, a);
  resetQuiz = async (noteId: string) => {
    const rows = await this.attemptsFor(noteId);
    await Promise.all(
      rows.map((r) => this.store.delete(COLLECTIONS.attempts, r.id)),
    );
  };

  // podcast
  podcastsFor = (noteId: string) =>
    this.store.where<Podcast>(COLLECTIONS.podcasts, { noteId });
  putPodcast = (p: Podcast) => this.store.put(COLLECTIONS.podcasts, p);

  // chat
  chatFor = async (noteId: string) =>
    (await this.store.where<ChatTurn>(COLLECTIONS.chat, { noteId })).sort(
      (a, b) => a.at - b.at,
    );
  putChat = (t: ChatTurn) => this.store.put(COLLECTIONS.chat, t);
  clearChat = async (noteId: string) => {
    const rows = await this.store.where<ChatTurn>(COLLECTIONS.chat, { noteId });
    await Promise.all(rows.map((r) => this.store.delete(COLLECTIONS.chat, r.id)));
  };

  // jobs
  listJobs = () => this.store.all<Job>(COLLECTIONS.jobs);
  putJob = (j: Job) => this.store.put(COLLECTIONS.jobs, j);
  activeJobs = async () =>
    (await this.store.all<Job>(COLLECTIONS.jobs)).filter(
      (j) => j.status === "running" || j.status === "queued",
    );
}
