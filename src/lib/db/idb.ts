/* IndexedDB Store implementation, backed by the `idb` package. One object
   store per entry in COLLECTIONS, keyed by "id". This is what the app uses
   at runtime; tests use memoryStore instead. */

import { openDB, type IDBPDatabase } from "idb";
import { COLLECTIONS, type Store } from "./index";

const DB_VERSION = 1;

export async function idbStore(name = "nitroai"): Promise<Store> {
  const db: IDBPDatabase = await openDB(name, DB_VERSION, {
    upgrade(database) {
      for (const collection of Object.values(COLLECTIONS)) {
        if (!database.objectStoreNames.contains(collection)) {
          database.createObjectStore(collection, { keyPath: "id" });
        }
      }
    },
  });

  return {
    async get<T>(collection: string, id: string): Promise<T | undefined> {
      return (await db.get(collection, id)) as T | undefined;
    },

    async put<T extends { id: string }>(collection: string, value: T): Promise<T> {
      await db.put(collection, value);
      return value;
    },

    async delete(collection: string, id: string): Promise<void> {
      await db.delete(collection, id);
    },

    async all<T>(collection: string): Promise<T[]> {
      return (await db.getAll(collection)) as T[];
    },

    async where<T>(collection: string, match: Partial<T>): Promise<T[]> {
      const entries = Object.entries(match as Record<string, unknown>);
      const rows = (await db.getAll(collection)) as T[];
      return rows.filter((row) =>
        entries.every(
          ([key, val]) => (row as Record<string, unknown>)[key] === val,
        ),
      );
    },

    async clear(collection: string): Promise<void> {
      await db.clear(collection);
    },
  };
}
