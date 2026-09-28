/* The first-run publik card (contract §12.1, founder 2026-09-19). Shown
   immediately after POST /installs succeeds — in onboarding and in Settings —
   and never skipped: an install must not spend a cent without having seen
   (a) the balance, (b) why it costs money and (c) the plan CTA.

   Order is fixed: balance line → justification → primary "Link this computer
   & pick a plan" (opens claim_url; publikhq.com links only) → "Later", which
   changes nothing. Since migration 0059 a new computer starts at $0.00 and
   its one free grant arrives when it is linked, so an unlinked $0.00 card
   says that instead of "$0.00 of free use". */

import { ExternalLink, Zap } from "lucide-react";
import { dollars, openExternal, publikUrl, type PublikStatus } from "../lib/publik";
import { cta, whyItCosts } from "../lib/publikCopy";

type StarterFields = Pick<PublikStatus, "starterMicros" | "balanceMicros" | "claimUrl">;

function starterMicrosOf(status: StarterFields): number | null {
  return typeof status.starterMicros === "number" ? status.starterMicros : typeof status.balanceMicros === "number" ? status.balanceMicros : null;
}

/* The new-computer case: nothing to spend yet, and a claim link to offer. */
export function unlinkedAtZero(status: StarterFields): boolean {
  const micros = starterMicrosOf(status);
  return micros !== null && micros <= 0 && publikUrl(status.claimUrl) !== null;
}

export function starterLineFor(status: StarterFields): string {
  const micros = starterMicrosOf(status);
  if (micros === null) return cta.starterUnknown;
  if (micros > 0) return cta.starterLine(dollars(micros));
  return unlinkedAtZero(status) ? cta.zeroStarterLine : cta.zeroBalanceLine;
}

export default function PublikWelcomeCard({
  status,
  onLink,
  onLater,
}: {
  /* The provision reply (starter_micros / balance_micros / claim_url). */
  status: PublikStatus;
  /* Called after claim_url was opened in the system browser. */
  onLink: () => void;
  onLater: () => void;
}) {
  const claimUrl = publikUrl(status.claimUrl);
  return (
    <div className="rounded-card border-2 border-accent bg-card p-6 text-left shadow-soft" data-testid="publik-welcome-card">
      <div className="flex items-center gap-2">
        <Zap className="size-5 text-accent" />
        <h2 className="font-display text-xl font-bold">{cta.cardTitle}</h2>
      </div>
      <p className="mt-3 font-display text-2xl font-bold text-ink" data-testid="publik-starter-line">
        {starterLineFor(status)}
      </p>
      <p className="mt-2 text-sm text-ink-dim">{whyItCosts}</p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        {claimUrl && (
          <button
            type="button"
            onClick={() => {
              openExternal(claimUrl);
              onLink();
            }}
            className="inline-flex items-center gap-1.5 rounded-xl bg-accent px-5 py-2.5 font-display font-bold text-white hover:bg-accent-hover"
          >
            {cta.linkLabel}
            <ExternalLink className="size-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={onLater}
          className="rounded-xl border border-edge bg-panel px-5 py-2.5 font-display font-bold text-ink-dim hover:text-ink"
        >
          {cta.laterLabel}
        </button>
      </div>
      <p className="mt-3 text-xs text-ink-faint">{unlinkedAtZero(status) ? cta.laterHintUnlinked : cta.laterHint}</p>
    </div>
  );
}
