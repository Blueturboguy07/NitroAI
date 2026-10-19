// @vitest-environment jsdom
/* Picking a sample quiz's scope: a course or unit ticks every lesson under
   it, a partly picked one shows as indeterminate, and empty folders can't be
   picked. The selection is only ever a set of note ids. */
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Folder, Note } from "../../lib/types";
import ScopePicker from "./ScopePicker";

const f = (id: string, name: string, extra: Partial<Folder> = {}): Folder => ({ id, name, createdAt: 0, ...extra });
const n = (id: string, title: string, folderId?: string): Note => ({
  id,
  title,
  folderId,
  sourceKind: "text",
  sourceText: "x",
  blocks: [],
  createdAt: 0,
  updatedAt: 0,
  lastOpenedAt: 0,
});

const folders = [
  f("bio", "BIO 101", { color: "grass", order: 0 }),
  f("u1", "Unit 1: Cells", { parentId: "bio", order: 0 }),
  f("u2", "Unit 2: Genetics", { parentId: "bio", order: 1 }),
  f("chem", "CHEM 120", { color: "sky", order: 1 }),
];
const notes = [
  n("n1", "Cell membranes", "u1"),
  n("n2", "Organelles", "u1"),
  n("n3", "DNA replication", "u2"),
  n("n5", "Study tips"),
];

let latest = new Set<string>();
function Harness({ initial = [] as string[] }) {
  const [selected, setSelected] = useState(new Set(initial));
  latest = selected;
  return <ScopePicker folders={folders} notes={notes} selected={selected} onChange={setSelected} />;
}

const box = (name: string) => screen.getByText(name).closest("label")!.querySelector("input")!;

afterEach(cleanup);

describe("ScopePicker", () => {
  it("ticks every lesson in a unit, and shows its course as partly picked", async () => {
    render(<Harness />);
    await userEvent.click(box("Unit 1: Cells"));
    expect([...latest].sort()).toEqual(["n1", "n2"]);
    expect(box("BIO 101").indeterminate).toBe(true);
    expect(box("BIO 101")).not.toBeChecked();
    expect(screen.getByText("2/3")).toBeInTheDocument();
  });

  it("ticks a whole course at once, then clears it", async () => {
    render(<Harness initial={["n1"]} />);
    await userEvent.click(box("BIO 101"));
    expect([...latest].sort()).toEqual(["n1", "n2", "n3"]);
    expect(box("BIO 101")).toBeChecked();
    expect(box("BIO 101").indeterminate).toBe(false);
    await userEvent.click(box("BIO 101"));
    expect(latest.size).toBe(0);
  });

  it("picks single lessons inside a unit", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Expand Unit 2: Genetics" }));
    await userEvent.click(box("DNA replication"));
    expect([...latest]).toEqual(["n3"]);
    expect(box("Unit 2: Genetics")).toBeChecked();
    expect(box("BIO 101").indeterminate).toBe(true);
  });

  it("can't pick an empty course, and offers notes that aren't in one", async () => {
    render(<Harness />);
    expect(box("CHEM 120")).toBeDisabled();
    await userEvent.click(box("Not in a course"));
    expect([...latest]).toEqual(["n5"]);
  });

  it("selects everything and clears", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(latest.size).toBe(4);
    expect(screen.getByText("4 lessons selected")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(latest.size).toBe(0);
  });
});
