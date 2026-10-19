import { describe, expect, it } from "vitest";
import {
  bucketOf,
  canNest,
  childrenOf,
  countAll,
  effectiveColor,
  nextColor,
  notesUnder,
  pathTo,
  placeFolder,
  sortNotes,
  sourceFileNames,
  sourceFilesLabel,
} from "./library";
import type { Folder, Note } from "./types";

const f = (id: string, extra: Partial<Folder> = {}): Folder => ({ id, name: id, createdAt: 0, ...extra });
const n = (id: string, extra: Partial<Note> = {}): Note => ({
  id,
  title: id,
  sourceKind: "blank",
  sourceText: "",
  blocks: [],
  createdAt: 0,
  updatedAt: 0,
  lastOpenedAt: 0,
  ...extra,
});

/*  phys (blue)
      m1
        week1
      m2
    chem (green)        */
const tree = [
  f("phys", { color: "blue", order: 0, name: "PHYS 241" }),
  f("m1", { parentId: "phys", order: 0, name: "Midterm 1" }),
  f("week1", { parentId: "m1", order: 0, name: "Week 1" }),
  f("m2", { parentId: "phys", order: 1, name: "Midterm 2" }),
  f("chem", { color: "grass", order: 1, name: "CHEM 120" }),
];

describe("folder tree", () => {
  it("lists children by order, then by name with numbers sorted naturally", () => {
    const folders = [f("a", { name: "Unit 10" }), f("b", { name: "Unit 2" }), f("c", { name: "Zeta", order: 0 })];
    expect(childrenOf(folders, undefined).map((x) => x.name)).toEqual(["Zeta", "Unit 2", "Unit 10"]);
  });

  it("treats folders with a missing parent as top level", () => {
    const folders = [f("orphan", { parentId: "gone" }), f("top")];
    expect(childrenOf(folders, undefined).map((x) => x.id).sort()).toEqual(["orphan", "top"]);
  });

  it("builds the root-first path to a folder", () => {
    expect(pathTo(tree, "week1").map((x) => x.id)).toEqual(["phys", "m1", "week1"]);
    expect(pathTo(tree, undefined)).toEqual([]);
  });

  it("refuses to nest a folder inside itself or its descendants", () => {
    expect(canNest(tree, "phys", "week1")).toBe(false);
    expect(canNest(tree, "phys", "phys")).toBe(false);
    expect(canNest(tree, "m1", "chem")).toBe(true);
    expect(canNest(tree, "m1", undefined)).toBe(true);
  });

  it("inherits the nearest ancestor's colour", () => {
    expect(effectiveColor(tree, "week1")).toBe("blue");
    expect(effectiveColor([...tree, f("labs", { parentId: "chem", color: "teal" })], "labs")).toBe("teal");
  });

  it("gives each new top-level folder an unused colour", () => {
    const c = nextColor(tree);
    expect(["blue", "grass", "slate"]).not.toContain(c);
  });

  it("counts notes directly inside and through subfolders", () => {
    const notes = [n("a", { folderId: "week1" }), n("b", { folderId: "phys" }), n("c")];
    const counts = countAll(tree, notes);
    expect(counts.get("phys")).toEqual({ notes: 1, total: 2, folders: 2 });
    expect(counts.get("m1")).toEqual({ notes: 0, total: 1, folders: 1 });
    expect(counts.get("chem")?.total).toBe(0);
  });

  it("finds every lesson under a course or unit, and the ones in no course", () => {
    const notes = [
      n("a", { folderId: "week1" }),
      n("b", { folderId: "phys" }),
      n("c", { folderId: "m2" }),
      n("d"),
      n("e", { folderId: "deleted-folder" }),
    ];
    const ids = (id: string | undefined) => notesUnder(tree, notes, id).map((x) => x.id).sort();
    expect(ids("phys")).toEqual(["a", "b", "c"]);
    expect(ids("m1")).toEqual(["a"]);
    expect(ids("chem")).toEqual([]);
    expect(ids(undefined)).toEqual(["d", "e"]);
  });
});

describe("placeFolder", () => {
  it("nests a folder inside another, at the end", () => {
    const changed = placeFolder(tree, "chem", "phys", "inside");
    const chem = changed.find((x) => x.id === "chem");
    expect(chem?.parentId).toBe("phys");
    expect(chem?.order).toBe(2);
  });

  it("reorders among siblings and renumbers them", () => {
    const changed = placeFolder(tree, "chem", "phys", "before");
    const byId = new Map(changed.map((x) => [x.id, x]));
    expect(byId.get("chem")).toMatchObject({ parentId: undefined, order: 0 });
    expect(byId.get("phys")).toMatchObject({ order: 1 });
  });

  it("moves a nested folder next to a top-level one", () => {
    const changed = placeFolder(tree, "m2", "chem", "after");
    expect(changed.find((x) => x.id === "m2")).toMatchObject({ parentId: undefined, order: 2 });
  });

  it("returns no changes for an impossible move", () => {
    expect(placeFolder(tree, "phys", "week1", "inside")).toEqual([]);
  });
});

describe("notes", () => {
  it("sorts by name naturally and by date newest first", () => {
    const notes = [n("x", { title: "Lecture 10", lastOpenedAt: 1 }), n("y", { title: "Lecture 2", lastOpenedAt: 5 })];
    expect(sortNotes(notes, "name").map((x) => x.title)).toEqual(["Lecture 2", "Lecture 10"]);
    expect(sortNotes(notes, "opened").map((x) => x.id)).toEqual(["y", "x"]);
  });

  it("buckets dates into today, this week, and earlier", () => {
    const noon = new Date(2026, 9, 16, 12).getTime();
    expect(bucketOf(noon - 3600_000, noon)).toBe("Today");
    expect(bucketOf(noon - 3 * 86400_000, noon)).toBe("This week");
    expect(bucketOf(noon - 30 * 86400_000, noon)).toBe("Earlier");
  });
});

describe("source files", () => {
  it("prefers sourceFiles, falls back to the legacy sourceMeta filename", () => {
    expect(sourceFileNames(n("a", { sourceFiles: ["a.pdf", "b.pdf"] }))).toEqual(["a.pdf", "b.pdf"]);
    expect(sourceFileNames(n("b", { sourceMeta: { filename: "old.pdf" } }))).toEqual(["old.pdf"]);
    expect(sourceFileNames(n("c"))).toEqual([]);
  });

  it("labels one file by name and several by first name plus a count", () => {
    expect(sourceFilesLabel([])).toBeNull();
    expect(sourceFilesLabel(["lecture.pdf"])).toBe("lecture.pdf");
    expect(sourceFilesLabel(["w1.mp3", "w2.mp3", "w3.mp3"])).toBe("w1.mp3 +2 more");
  });
});
