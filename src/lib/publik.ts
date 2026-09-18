/* Renderer side of publik API. Mirrors localSetup.ts: everything goes to the
   local server's /api/publik/* routes with relative URLs, and a non-JSON
   answer means "no desktop shell here" (plain `npm run dev`).

   The renderer never sees the pk_ key. It learns whether publik is
   available / provisioned / disconnected, asks the server to mint AFTER the
   user accepted the disclosure, and keeps a small balance store fed by the
   x-publik-* headers of every call (with GET /wallet as the fallback). */

import { EngineError, type EngineCapabilities } from "./engine/types";
import type { UsageHeaders } from "./engine/openai";
import { settings as copy } from "./publikCopy";

export interface PublikStatus {
  /* Can publik be offered on this machine at all (a build token, a
     credential file, or PUBLIK_API_KEY)? False in forks and dev builds. */
  available: boolean;
  state: "unprovisioned" | "ready" | "disconnected";
  source?: "env" | "file";
  baseUrl: string;
  models?: Record<string, string>;
  dialects?: string[];
  lines?: string[] | null;
  claimUrl?: string | null;
  claimCode?: string | null;
  installId?: string;
  disclosureVersion?: number;
  starterMicros?: number | null;
  balanceMicros?: number | null;
  mintedAt?: string | null;
  /* On the provision answer only. */
  ok?: boolean;
  minted?: boolean;
  reason?: string | null;
}

const NO_SERVER: PublikStatus = { available: false, state: "unprovisioned", baseUrl: "/api/publik/v1", reason: "no_server" };

async function call(path: string, init?: RequestInit, timeoutMs = 12_000): Promise<PublikStatus> {
  try {
    const res = await fetch(path, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (!(res.headers.get("content-type") ?? "").includes("application/json")) return NO_SERVER;
    return (await res.json()) as PublikStatus;
  } catch {
    return { ...NO_SERVER, reason: "network" };
  }
}

export function fetchPublikStatus(): Promise<PublikStatus> {
  return call("/api/publik/status", undefined, 5000);
}

/* Consent precedes mint: call this only from the disclosure's "Continue".
   `force` = an explicit Reconnect after the install was removed. */
export function provisionPublik(disclosureVersion: number, force = false): Promise<PublikStatus> {
  return call(
    "/api/publik/provision",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disclosure_version: disclosureVersion, force }),
    },
    20_000,
  );
}

export function forgetPublik(): Promise<PublikStatus> {
  return call("/api/publik/forget", { method: "POST" });
}

export function disconnectPublik(): Promise<PublikStatus> {
  return call("/api/publik/disconnect", { method: "POST" });
}

/* GET /wallet (R21 §2.3 shape) — the balance line's fallback and refresh. */
export interface PublikWallet {
  balance_micros: number;
  claim_state?: "anonymous" | "claimed";
  starter?: { remaining_micros: number; expires_at?: string };
  plan?: { id: string; label: string; monthly_micros: number };
  week?: { used_micros: number; budget_micros: number | null; resets_at: string };
  daily_cap_micros?: number;
  spent_today_micros?: number;
  claim_url?: string | null;
  add_credit_url?: string | null;
}

export async function fetchPublikWallet(): Promise<PublikWallet | null> {
  try {
    const res = await fetch("/api/publik/wallet", { signal: AbortSignal.timeout(6000) });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("application/json")) return null;
    const w = (await res.json()) as PublikWallet;
    if (typeof w.balance_micros !== "number") return null;
    setBalance({
      balanceMicros: w.balance_micros,
      claimState: w.claim_state,
      starterRemainingMicros: w.starter?.remaining_micros,
      weekUsedMicros: w.week?.used_micros,
      weekBudgetMicros: w.week?.budget_micros ?? null,
      weekResetsAt: w.week?.resets_at,
      dailyCapMicros: w.daily_cap_micros,
      spentTodayMicros: w.spent_today_micros,
      claimUrl: publikUrl(w.claim_url) ?? undefined,
      addCreditUrl: publikUrl(w.add_credit_url) ?? undefined,
      source: "wallet",
    });
    return w;
  } catch {
    return null;
  }
}

/* ---- Balance store (tiny event emitter, no prop drilling) ---------------- */

export interface PublikBalance {
  balanceMicros?: number;
  claimState?: string;
  starterRemainingMicros?: number;
  weekUsedMicros?: number;
  weekBudgetMicros?: number | null;
  weekResetsAt?: string;
  dailyCapMicros?: number;
  spentTodayMicros?: number;
  lastChargeMicros?: number;
  lastReservedMicros?: number;
  claimUrl?: string;
  addCreditUrl?: string;
  /* "headers" after a metered call, "wallet" after GET /wallet. Streams
     settle after their headers, so a streamed call marks the balance stale
     until the next wallet refresh. */
  source?: "headers" | "wallet";
  stale?: boolean;
  updatedAt?: number;
}

let balance: PublikBalance = {};
const listeners = new Set<(b: PublikBalance) => void>();

export function getBalance(): PublikBalance {
  return balance;
}

export function setBalance(patch: PublikBalance): void {
  balance = { ...balance, ...patch, updatedAt: Date.now() };
  for (const l of listeners) l(balance);
}

export function resetBalance(): void {
  balance = {};
  for (const l of listeners) l(balance);
}

export function subscribeBalance(fn: (b: PublikBalance) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/* The engine's onUsage hook → the store. */
export function usageToBalance(u: UsageHeaders): void {
  setBalance({
    ...(u.balanceMicros !== undefined ? { balanceMicros: u.balanceMicros } : {}),
    ...(u.claimState !== undefined ? { claimState: u.claimState } : {}),
    ...(u.starterRemainingMicros !== undefined ? { starterRemainingMicros: u.starterRemainingMicros } : {}),
    ...(u.weekUsedMicros !== undefined ? { weekUsedMicros: u.weekUsedMicros } : {}),
    ...(u.weekBudgetMicros !== undefined ? { weekBudgetMicros: u.weekBudgetMicros } : {}),
    ...(u.weekResetsAt !== undefined ? { weekResetsAt: u.weekResetsAt } : {}),
    ...(u.chargeMicros !== undefined ? { lastChargeMicros: u.chargeMicros } : {}),
    ...(u.reservedMicros !== undefined ? { lastReservedMicros: u.reservedMicros } : {}),
    source: "headers",
    stale: u.streamed,
  });
}

/* ---- Formatting ---------------------------------------------------------- */

export function dollars(micros: number): string {
  const d = micros / 1_000_000;
  if (micros !== 0 && Math.abs(micros) < 10_000) return `$${d.toFixed(4)}`;
  return `$${d.toFixed(2)}`;
}

/* "$4.87 left · $0.13 used this week of $1.85 · resets Thu" */
export function balanceLine(b: PublikBalance): string {
  if (b.balanceMicros === undefined) return "";
  const parts = [`${dollars(b.balanceMicros)} left`];
  if (b.weekUsedMicros !== undefined) {
    parts.push(
      b.weekBudgetMicros != null
        ? `${dollars(b.weekUsedMicros)} used this week of ${dollars(b.weekBudgetMicros)}`
        : `${dollars(b.weekUsedMicros)} used this week`,
    );
  }
  if (b.weekBudgetMicros != null && b.weekResetsAt) {
    const d = new Date(b.weekResetsAt);
    if (!Number.isNaN(d.getTime())) {
      parts.push(`resets ${d.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`);
    }
  }
  return parts.join(" · ");
}

/* Capability bits: the gateway carries every line (contract §3.1); an
   optional per-install `lines` list can narrow them without an app release. */
export function linesToCapabilities(lines: string[] | null | undefined): EngineCapabilities {
  if (!Array.isArray(lines)) return { chat: true, transcription: true, tts: true, embeddings: true };
  return {
    chat: lines.includes("chat"),
    transcription: lines.includes("audio") || lines.includes("transcription"),
    tts: lines.includes("tts") || lines.includes("speech"),
    embeddings: lines.includes("embeddings"),
  };
}

/* Contract §11.4: claim_url / add_credit_url / plans_url are always on
   https://publikhq.com/…; anything else is dropped before it can be opened. */
export function publikUrl(u: unknown): string | null {
  return typeof u === "string" && /^https:\/\/publikhq\.com\//.test(u) ? u : null;
}

/* ---- Errors → what the UI shows ------------------------------------------ */

export interface CreditAction {
  label: string;
  url: string;
}

/* A 402 renders the message plus EXACTLY ONE link: top_up_url. */
export function creditAction(e: unknown): CreditAction | null {
  if (e instanceof EngineError && e.kind === "credit") {
    const url = publikUrl(e.detail.topUpUrl);
    if (url) {
      return {
        label: e.detail.claimState === "claimed" ? copy.addCreditLabel : "Link this computer",
        url,
      };
    }
  }
  return null;
}

/* The message to show for a publik engine error (R21 §4.1 states). */
export function publikErrorMessage(e: unknown): string | null {
  if (!(e instanceof EngineError)) return null;
  if (e.kind === "credit") {
    if (e.detail.retryAfterSeconds && !e.detail.topUpUrl) return e.message;
    return e.detail.claimState === "claimed" ? `${copy.exhaustedClaimed} ${e.message}` : copy.exhaustedAnonymous;
  }
  if (e.kind === "auth" && e.detail.disconnected) return copy.disconnected;
  return null;
}

export function openExternal(url: string): void {
  window.open(url, "_blank", "noopener");
}

/* One shape for every error surface: the text to show and, for a publik 402,
   the single link to render next to it. */
export interface ShownError {
  message: string;
  action: CreditAction | null;
}

export function describeError(e: unknown, fallback = "Something went wrong."): ShownError {
  const message = publikErrorMessage(e) ?? (e instanceof Error ? e.message : fallback);
  return { message, action: creditAction(e) };
}
