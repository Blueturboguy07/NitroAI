/* The "publik API" panel in Settings (R21 §4.1). Four states:
     ready        → balance line, capability line, link / add credit / pricing,
                    "use my own key instead", disconnect
     disconnected → the install was removed from the user's account
     unprovisioned→ the disclosure (consent precedes mint)
     unreachable  → nothing is charged; retry
   The balance line is fed by the x-publik-* headers of every call and by
   GET /wallet as the fallback/refresh. */

import { useEffect, useState } from "react";
import { ExternalLink, RefreshCw, Zap } from "lucide-react";
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
import { DISCLOSURE_VERSION, PUBLIK_PRICING_URL, settings as copy } from "../lib/publikCopy";
import { PublikDisclosure } from "./PublikNotice";

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
  const addCreditUrl = publikUrl(balance.addCreditUrl);
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
                  ? `${dollars(status.starterMicros)} free starter balance`
                  : "Balance loading…"}
          </p>
          {!unreachable && anonymous && balance.starterRemainingMicros !== undefined && status.starterMicros != null && (
            <p className="mt-0.5 text-xs text-ink-faint">
              {dollars(balance.starterRemainingMicros)} left of {dollars(status.starterMicros)} free starter balance
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

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        {anonymous && linkUrl && (
          <button
            onClick={() => openExternal(linkUrl)}
            className="inline-flex items-center gap-1 rounded-xl bg-accent px-4 py-2 text-sm font-bold text-white hover:bg-accent-hover"
          >
            {copy.linkLabel}
            <ExternalLink className="size-3" />
          </button>
        )}
        {!anonymous && addCreditUrl && (
          <button
            onClick={() => openExternal(addCreditUrl)}
            className="inline-flex items-center gap-1 rounded-xl bg-accent px-4 py-2 text-sm font-bold text-white hover:bg-accent-hover"
          >
            {copy.addCreditLabel}
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
