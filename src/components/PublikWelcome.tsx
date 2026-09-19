/* The first-run publik card (contract §12.1, founder 2026-09-19). Shown
   immediately after POST /installs succeeds — in onboarding and in Settings —
   and never skipped: an install must not spend the starter without having
   seen (a) the balance, (b) why it costs money and (c) the plan CTA.

   Order is fixed: balance line → justification → primary "Link this computer
   & pick a plan" (opens claim_url; publikhq.com links only) → "Later", which
   keeps the free starter and changes nothing else. */

import { ExternalLink, Zap } from "lucide-react";
import { dollars, openExternal, publikUrl, type PublikStatus } from "../lib/publik";
import { cta, whyItCosts } from "../lib/publikCopy";

export function starterLineFor(status: Pick<PublikStatus, "starterMicros" | "balanceMicros">): string {
  const micros =
    typeof status.starterMicros === "number" ? status.starterMicros : typeof status.balanceMicros === "number" ? status.balanceMicros : null;
  return micros === null ? cta.starterUnknown : cta.starterLine(dollars(micros));
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
      <p className="mt-3 text-xs text-ink-faint">{cta.laterHint}</p>
    </div>
  );
}
