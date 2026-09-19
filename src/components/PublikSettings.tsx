/* The "publik API" panel in Settings (R21 §4.1, contract §12.2). States:
     just minted  → the first-run card (balance, why it costs, plan CTA)
     ready        → balance line, "Pick a plan" / "Manage plan", why-it-costs
                    toggle, pricing, "use my own key instead", disconnect
     disconnected → the install was removed from the user's account
     unprovisioned→ the disclosure (consent precedes mint)
     unreachable  → nothing is charged; retry
   The balance line is fed by the x-publik-* headers of every call and by
   GET /wallet as the fallback/refresh. */

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink, RefreshCw, Zap } from "lucide-react";
import type { Engine } from "../lib/engine/types";
import {
  balanceLine,
  disconnectPublik,
  dollars,
  fetchPublikStatus,
  fetchPublikWallet,
  forgetPublik,
  getBalance,
  openExternal,
  provisionPublik,
  publikUrl,
  resetBalance,
  subscribeBalance,
  type PublikBalance,
  type PublikStatus,
} from "../lib/publik";
import { cta, DISCLOSURE_VERSION, PUBLIK_DASHBOARD_URL, PUBLIK_PRICING_URL, settings as copy, whyItCosts } from "../lib/publikCopy";
import { PublikDisclosure } from "./PublikNotice";
import PublikWelcomeCard from "./PublikWelcome";

export default function PublikSettings({
  engine,
  disclosureAck,
  onActivated,
  onOwnKey,
  onLeft,
}: {
  engine: Engine | null;
  /* prefs.publikDisclosureAck — below DISCLOSURE_VERSION means "show the
     disclosure before using publik", even when a credential already exists. */
  disclosureAck: number;
  /* The credential is ready and the disclosure was accepted → prefs.mode = "publik". */
  onActivated: () => void;
  onOwnKey: () => void;
  /* Disconnected / forgotten → prefs.mode = null. */
  onLeft: () => void;
}) {
  const [status, setStatus] = useState<PublikStatus | null>(null);
  const [balance, setBalanceState] = useState<PublikBalance>(getBalance());
  const [unreachable, setUnreachable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* Set right after a successful mint from this panel: the first-run card
     (contract §12.1) shows until "Later" or the plan link. */
  const [justMinted, setJustMinted] = useState<PublikStatus | null>(null);
  const [whyOpen, setWhyOpen] = useState(false);

  async function refresh() {
    const s = await fetchPublikStatus();
    setStatus(s);
    if (s.state === "ready") {
      const w = await fetchPublikWallet();
      setUnreachable(w === null);
    }
  }

  useEffect(() => {
    void refresh();
    return subscribeBalance(setBalanceState);
  }, []);

  async function continueWithPublik() {
    setBusy(true);
    setError(null);
    const r = await provisionPublik(DISCLOSURE_VERSION, status?.state === "disconnected");
    setBusy(false);
    if (r.ok && r.state === "ready") {
      setStatus(r);
      setJustMinted(r);
      onActivated();
      void fetchPublikWallet().then((w) => setUnreachable(w === null));
      return;
    }
    setStatus(r);
    setError(r.reason === "rate_limited" ? "publik API can't set up another install from this network right now." : copy.unreachable);
  }

  if (!status) return <p className="mt-5 text-sm text-ink-faint">Checking publik API…</p>;

  if (!status.available) {
    return <p className="mt-5 text-sm text-ink-faint">publik API isn't available in this build. Use your own key or Local mode.</p>;
  }

  if (status.state === "disconnected") {
    return (
      <div className="mt-5 rounded-xl border border-danger-ink/30 bg-danger-soft p-4 text-sm text-danger-ink">
        <p className="font-semibold">{copy.disconnected}</p>
        {error && <p className="mt-1 text-xs">{error}</p>}
        <div className="mt-3 flex flex-wrap gap-3">
          <button onClick={continueWithPublik} disabled={busy} className="rounded-xl bg-accent px-4 py-2 text-sm font-bold text-white hover:bg-accent-hover disabled:opacity-60">
            {busy ? "Reconnecting…" : copy.reconnectLabel}
          </button>
          <button onClick={onOwnKey} className="text-sm font-semibold text-ink-dim hover:text-ink">
            {copy.ownKeyLabel}
          </button>
        </div>
      </div>
    );
  }

  if (justMinted) {
    return (
      <div className="mt-5">
        <PublikWelcomeCard status={justMinted} onLink={() => setJustMinted(null)} onLater={() => setJustMinted(null)} />
      </div>
    );
  }

  if (status.state !== "ready" || disclosureAck < DISCLOSURE_VERSION) {
    return (
      <div className="mt-5">
        <PublikDisclosure busy={busy} error={error} onContinue={continueWithPublik} onOwnKey={onOwnKey} />
      </div>
    );
  }

  const caps = engine?.provider === "publik" ? engine.capabilities() : null;
  const anonymous = (balance.claimState ?? "anonymous") !== "claimed";
  const linkUrl = publikUrl(balance.claimUrl) ?? publikUrl(status.claimUrl);
  /* Contract §12.2: "Pick a plan" → claim_url while anonymous; once claimed
     "Manage plan" → the dashboard's API page. */
  const planUrl = anonymous ? linkUrl : PUBLIK_DASHBOARD_URL;
  const line = balanceLine(balance);

  return (
    <div className="mt-5 rounded-xl border border-edge bg-panel p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <Zap className="size-4 text-accent" />
            publik API
            <span className="text-ink-faint">·</span>
            <span className="text-ink-dim">{anonymous ? "Ready" : "Connected to your publik account"}</span>
          </p>
          <p className="mt-1 text-sm text-ink-dim" data-testid="publik-balance-line">
            {unreachable
              ? copy.unreachable
              : line
                ? `${line}${balance.stale ? " · updating…" : ""}`
                : status.starterMicros != null
                  ? cta.starterLine(dollars(status.starterMicros))
                  : "Balance loading…"}
          </p>
          {!unreachable && anonymous && balance.starterRemainingMicros !== undefined && status.starterMicros != null && (
            <p className="mt-0.5 text-xs text-ink-faint">
              {dollars(balance.starterRemainingMicros)} left of {cta.starterLine(dollars(status.starterMicros))}
            </p>
          )}
          {balance.lastChargeMicros !== undefined && (
            <p className="mt-0.5 text-xs text-ink-faint">Last request: {dollars(balance.lastChargeMicros)}</p>
          )}
        </div>
        <button
          onClick={() => void refresh()}
          className="rounded-lg border border-edge bg-card p-2 text-ink-dim shadow-soft hover:text-ink"
          aria-label="Refresh balance"
        >
          <RefreshCw className="size-3.5" />
        </button>
      </div>

      <p className="mt-3 text-xs text-ink-faint">{copy.rate}</p>
      <p className="mt-1 text-xs text-ink-faint">{copy.data}</p>
      {caps && (
        <p className="mt-2 text-xs text-ink-faint">
          Chat, notes, flashcards, quizzes: {caps.chat ? "on" : "off"}. Audio transcription:{" "}
          {caps.transcription ? "on" : "off"}. Podcast voices: {caps.tts ? "on" : "off"}. {copy.atCost}
        </p>
      )}

      <div className="mt-3">
        <button
          type="button"
          onClick={() => setWhyOpen((o) => !o)}
          aria-expanded={whyOpen}
          className="inline-flex items-center gap-1 text-xs font-semibold text-ink-dim hover:text-ink"
        >
          {whyOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          {cta.whyLabel}
        </button>
        {whyOpen && <p className="mt-1 text-xs text-ink-dim" data-testid="publik-why-it-costs">{whyItCosts}</p>}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        {planUrl && (
          <button
            onClick={() => openExternal(planUrl)}
            className="inline-flex items-center gap-1 rounded-xl bg-accent px-4 py-2 text-sm font-bold text-white hover:bg-accent-hover"
          >
            {anonymous ? cta.pickPlanLabel : cta.managePlanLabel}
            <ExternalLink className="size-3" />
          </button>
        )}
        <button onClick={() => openExternal(PUBLIK_PRICING_URL)} className="text-sm font-semibold text-ink-dim hover:text-ink">
          {copy.pricingLabel}
        </button>
        <button onClick={onOwnKey} className="text-sm font-semibold text-ink-dim hover:text-ink">
          {copy.ownKeyLabel}
        </button>
        {unreachable && (
          <button onClick={() => void refresh()} className="text-sm font-semibold text-ink-dim hover:text-ink">
            {copy.retryLabel}
          </button>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-4 border-t border-edge pt-3">
        <button
          onClick={async () => {
            await disconnectPublik();
            resetBalance();
            onLeft();
          }}
          className="text-xs font-semibold text-ink-faint hover:text-danger-ink"
        >
          {anonymous ? copy.forgetLabel : copy.disconnectLabel}
        </button>
        {!anonymous && (
          <button
            onClick={async () => {
              await forgetPublik();
              resetBalance();
              onLeft();
            }}
            className="text-xs font-semibold text-ink-faint hover:text-danger-ink"
          >
            {copy.forgetLabel}
          </button>
        )}
      </div>
    </div>
  );
}
