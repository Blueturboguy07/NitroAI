import { v4 } from "uuid";

/* Single id source so tests can mock it in one place if needed. */
export const uuid = (): string => v4();

export const now = (): number => Date.now();
