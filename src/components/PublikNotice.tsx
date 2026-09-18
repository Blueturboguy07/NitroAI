/* Shared publik API surfaces: the first-run disclosure sheet (R21 §4.3) and
   the error notice that renders a message plus — for a 402 — exactly one
   link, top_up_url (contract §1). */

import { AlertCircle, ExternalLink, Zap } from "lucide-react";
import { openExternal, type ShownError } from "../lib/publik";
import { disclosure, PUBLIK_TERMS_URL } from "../lib/publikCopy";

export function ErrorNotice({ err, compact = false }: { err: ShownError | null; compact?: boolean }) {
  if (!err) return null;
  return (
    <div
      role="alert"
      className={
        compact
          ? "mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-semibold text-danger-ink"
          : "flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-danger-ink/30 bg-danger-soft px-4 py-3 text-sm font-semibold text-danger-ink"
      }
    >
      {!compact && <AlertCircle className="size-4 shrink-0" />}
      <span className="min-w-0 flex-1">{err.message}</span>
      {err.action && (
        <button
          type="button"
          onClick={() => openExternal(err.action!.url)}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-xs font-bold text-white hover:bg-accent-hover"
        >
          {err.action.label}
          <ExternalLink className="size-3" />
        </button>
      )}
    </div>
  );
}

/* The two-sentence disclosure. Shown once per install, before the first
   gateway call — as the last step of the app's own onboarding, and again in
   Settings if the user picks publik there before ever accepting it. Two
   buttons, primary first, no third "later". "Continue" is what mints. */
export function PublikDisclosure({
  onContinue,
  onOwnKey,
  busy,
  error,
}: {
  onContinue: () => void;
  onOwnKey: () => void;
  busy?: boolean;
  error?: string | null;
}) {
  return (
    <div className="rounded-card border-2 border-accent bg-card p-6 text-left shadow-soft">
      <div className="flex items-center gap-2">
        <Zap className="size-5 text-accent" />
        <h2 className="font-display text-xl font-bold">{disclosure.title}</h2>
      </div>
      <p className="mt-2 text-sm text-ink-dim">{disclosure.intro}</p>
      <p className="mt-3 text-sm text-ink-dim">
        <span className="font-bold text-ink">{disclosure.costHeading}</span> {disclosure.cost}
      </p>
      <p className="mt-2 text-sm text-ink-dim">
        <span className="font-bold text-ink">{disclosure.dataHeading}</span> {disclosure.data}
      </p>
      {error && <p className="mt-3 text-xs font-semibold text-danger-ink">{error}</p>}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onContinue}
          disabled={busy}
          className="rounded-xl bg-accent px-5 py-2.5 font-display font-bold text-white hover:bg-accent-hover disabled:opacity-60"
        >
          {busy ? "Setting up…" : disclosure.continueLabel}
        </button>
        <button
          type="button"
          onClick={onOwnKey}
          disabled={busy}
          className="rounded-xl border border-edge bg-panel px-5 py-2.5 font-display font-bold text-ink-dim hover:text-ink disabled:opacity-60"
        >
          {disclosure.ownKeyLabel}
        </button>
      </div>
      <p className="mt-3 text-xs text-ink-faint">
        {disclosure.termsPrefix}{" "}
        <a
          href={PUBLIK_TERMS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold text-accent underline-offset-2 hover:underline"
        >
          {disclosure.termsLink}
        </a>
        .
      </p>
    </div>
  );
}
