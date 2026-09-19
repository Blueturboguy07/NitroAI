/* Non-blocking banner (contract §12.3, task item 3). Two triggers, one at a
   time, each with the message and EXACTLY ONE link:
     - a 402 arrived → the gateway's own message + top_up_url
     - the starter is below 20% while anonymous → a computed line + claim_url
   Dismissable; the 402 notice also clears itself on the next successful
   metered call. Only rendered while the active engine is publik. */

import { useEffect, useState } from "react";
import { AlertCircle, ExternalLink, X } from "lucide-react";
import { useApp } from "../lib/app";
import {
  clearCreditNotice,
  dollars,
  getBalance,
  openExternal,
  publikUrl,
  starterIsLow,
  subscribeBalance,
  type PublikBalance,
} from "../lib/publik";
import { cta, whyItCosts } from "../lib/publikCopy";

interface Shown {
  key: string;
  message: string;
  url: string;
  label: string;
}

export function bannerFor(b: PublikBalance): Shown | null {
  if (b.creditNotice) {
    const url = publikUrl(b.creditNotice.url);
    if (url) {
      return {
        key: `credit:${b.creditNotice.at}`,
        message: b.creditNotice.message,
        url,
        label: (b.creditNotice.claimState ?? b.claimState) === "claimed" ? cta.managePlanLabel : cta.lowStarterLink,
      };
    }
  }
  if (starterIsLow(b)) {
    const url = publikUrl(b.claimUrl);
    if (url) {
      return {
        key: "low-starter",
        message: `${cta.lowStarter(dollars(b.starterRemainingMicros!), dollars(b.starterMicros!))} ${whyItCosts}`,
        url,
        label: cta.lowStarterLink,
      };
    }
  }
  return null;
}

export default function PublikBanner() {
  const { engine } = useApp();
  const [balance, setBalance] = useState<PublikBalance>(getBalance());
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => subscribeBalance(setBalance), []);

  if (engine?.provider !== "publik") return null;
  const shown = bannerFor(balance);
  if (!shown || dismissed === shown.key) return null;

  return (
    <div
      role="status"
      data-testid="publik-banner"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-accent/30 bg-accent-softer px-6 py-2.5 text-sm text-ink"
    >
      <AlertCircle className="size-4 shrink-0 text-accent" />
      <span className="min-w-0 flex-1">{shown.message}</span>
      <button
        type="button"
        onClick={() => openExternal(shown.url)}
        className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-xs font-bold text-white hover:bg-accent-hover"
      >
        {shown.label}
        <ExternalLink className="size-3" />
      </button>
      <button
        type="button"
        onClick={() => {
          setDismissed(shown.key);
          if (shown.key.startsWith("credit:")) clearCreditNotice();
        }}
        className="rounded-lg p-1 text-ink-faint hover:text-ink"
        aria-label={cta.dismissLabel}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
