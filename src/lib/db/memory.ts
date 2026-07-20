/* In-memory Store implementation. Used by tests and as a fallback when
   IndexedDB is unavailable. Backed by a Map of collection name -> Map of id
   -> value. Values are deep-cloned on the way in and out so callers can
   never mutate stored state through a returned reference. */

import type { Store } from "./index";

export function memoryStore(): Store {
  const collections = new Map<string, Map<string, unknown>>();

  function tableFor(collection: string): Map<string, unknown> {
    let table = collections.get(collection);
    if (!table) {
      table = new Map<string, unknown>();
      collections.set(collection, table);
    }
    return table;
  }

  return {
    async get<T>(collection: string, id: string): Promise<T | undefined> {
      const value = tableFor(collection).get(id);
      return value === undefined ? undefined : structuredClone(value as T);
    },

    async put<T extends { id: string }>(collection: string, value: T): Promise<T> {
      const clone = structuredClone(value);
      tableFor(collection).set(clone.id, clone);
      return structuredClone(clone);
    },

    async delete(collection: string, id: string): Promise<void> {
      tableFor(collection).delete(id);
    },

    async all<T>(collection: string): Promise<T[]> {
      return Array.from(tableFor(collection).values()).map((v) =>
        structuredClone(v as T),
      );
    },

    async where<T>(collection: string, match: Partial<T>): Promise<T[]> {
      const entries = Object.entries(match as Record<string, unknown>);
      return Array.from(tableFor(collection).values())
        .filter((v) =>
          entries.every(
            ([key, val]) => (v as Record<string, unknown>)[key] === val,
          ),
        )
        .map((v) => structuredClone(v as T));
    },

    async clear(collection: string): Promise<void> {
      tableFor(collection).clear();
    },
  };
}
