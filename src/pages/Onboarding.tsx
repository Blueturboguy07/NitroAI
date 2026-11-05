import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, ChevronRight, Cloud, Cpu, KeyRound, PenLine } from "lucide-react";
import { detectProvider, saveApiKey } from "../lib/engine/keys";
import { getEnginePrefs } from "../lib/prefs";
import { localSetupStatus } from "../lib/localSetup";
import { fetchPublikStatus, fetchPublikWallet, openExternal, provisionPublik, publikUrl, type PublikStatus } from "../lib/publik";
import { DISCLOSURE_VERSION, otherWays, settings as publikCopy } from "../lib/publikCopy";
import LocalSetupModal from "../components/LocalSetupModal";
import { PublikDisclosure } from "../components/PublikNotice";
import PublikWelcomeCard from "../components/PublikWelcome";
import { useApp } from "../lib/app";
import type { EngineMode } from "../lib/types";

function provisionFailureText(reason: string | null | undefined): string {
  switch (reason) {
    case "token_revoked":
    case "no_app_token":
      return "publik API isn't available for this build. Use your own key or Local mode.";
    case "rate_limited":
      return "publik API can't set up another install from this network right now. Try again later, or use your own key.";
    case "gateway_unavailable":
    case "network":
    case "no_server":
      return publikCopy.unreachable;
    default:
      return publikCopy.unreachable;
  }
}

/* How often the first-run card asks GET /wallet whether the computer is
   linked yet (after the one press opened the claim page). */
export const LINK_POLL_MS = 3000;

export default function Onboarding() {
  const navigate = useNavigate();
  const { savePrefs } = useApp();
  /* publik first (founder, 2026-11-02): when this build can offer publik API
     (a token was baked in at build time, or a credential already exists), the
     first screen IS the publik disclosure with one primary button, "Continue
     with publik API". Local and the user's own key sit below it, in a section
     that starts closed. Without publik the page is exactly the two-card page
     it always was: the user must choose. */
  const [publik, setPublik] = useState<PublikStatus | null>(null);
  const [mode, setMode] = useState<EngineMode | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [publikError, setPublikError] = useState<string | null>(null);
  /* The provision reply, once POST /installs succeeded. While set, the page
     is the first-run card (contract §12.1) — the app is never entered before
     the balance, the justification and the plan CTA were shown. */
  const [provisioned, setProvisioned] = useState<PublikStatus | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  /* "Other ways to run NitroAI" (own key, local): closed until opened. */
  const [othersOpen, setOthersOpen] = useState(false);
  /* The one press opened the claim page; the card waits for the link. */
  const [linkOpened, setLinkOpened] = useState(false);
  const provider = detectProvider(apiKey.trim());
  const ready = mode === "local" || (mode === "cloud" && provider !== null);
  const publikOffered = publik?.available === true;

  useEffect(() => {
    let alive = true;
    fetchPublikStatus().then((s) => {
      if (!alive) return;
      setPublik(s);
    });
    return () => {
      alive = false;
    };
  }, []);

  function enter(nextMode: EngineMode, chatModel?: string) {
    const prefs = getEnginePrefs();
    savePrefs({
      ...prefs,
      mode: nextMode,
      onboarded: true,
      // Persist which local model is actually in use, so future launches (and
      // the "is setup already done" check below) respect it instead of only
      // ever recognizing the hardcoded default.
      localModel: chatModel ?? prefs.localModel,
      ...(nextMode === "publik" ? { publikDisclosureAck: DISCLOSURE_VERSION } : {}),
    });
    navigate("/", { replace: true });
  }

  /* Once the claim page is open, enter the app by itself as soon as the
     wallet says this computer is linked. "Later" still enters at once. */
  useEffect(() => {
    if (!provisioned || !linkOpened) return;
    let alive = true;
    const timer = setInterval(() => {
      void fetchPublikWallet().then((w) => {
        if (alive && w?.claim_state === "claimed") {
          clearInterval(timer);
          enter("publik");
        }
      });
    }, LINK_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provisioned, linkOpened]);

  /* "Continue with publik API" — the consent that triggers the mint, and
     (one press connects and links) the claim page opens right away. Nothing
     is typed, nothing is written to the user's own key slot. */
  async function continueWithPublik() {
    if (busy) return;
    setBusy(true);
    setPublikError(null);
    const r = await provisionPublik(DISCLOSURE_VERSION, publik?.state === "disconnected");
    if (r.ok && r.state === "ready") {
      setPublik(r);
      setProvisioned(r);
      setBusy(false);
      // A fresh mint only: an install that already existed may be linked.
      const claimUrl = publikUrl(r.claimUrl);
      if (r.minted && claimUrl) {
        openExternal(claimUrl);
        setLinkOpened(true);
      }
      return;
    }
    setPublik(r);
    setPublikError(provisionFailureText(r.reason));
    setBusy(false);
  }

  async function finish() {
    if (!mode || busy) return;
    setBusy(true);
    if (mode === "cloud") {
      await saveApiKey(apiKey.trim());
      enter("cloud");
      return;
    }
    // Local: provision Ollama first IF a setup server is present and not already
    // ready. On a static/dev host with no server, proceed and let the engine
    // use a manually-running Ollama. Check against any model the user already
    // chose/pulled before (not just our default) so a returning user isn't
    // asked to download again.
    const prefs = getEnginePrefs();
    const status = await localSetupStatus({ chatModel: prefs.localModel || undefined });
    const alreadyReady = status?.serving && status.hasChatModel && status.hasEmbedModel;
    if (status && !alreadyReady) {
      setSetupOpen(true);
      return;
    }
    enter("local");
  }

  if (provisioned) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-bg px-6">
        <div className="flex items-center gap-2">
          <PenLine className="size-7 text-accent" />
          <span className="font-display text-2xl font-bold tracking-tight">nitro ai</span>
        </div>
        <div className="mt-8 w-full max-w-3xl">
          <PublikWelcomeCard
            status={provisioned}
            opened={linkOpened}
            onLink={() => {
              if (!linkOpened) enter("publik");
            }}
            onLater={() => enter("publik")}
          />
        </div>
      </div>
    );
  }

  const localCard = (
    <ModeCard
      active={mode === "local"}
      onClick={() => setMode("local")}
      icon={Cpu}
      title="Fully local"
      body="Everything runs on this device — private, offline, zero cost. Best for privacy; long lectures and quiz distractors are a little weaker than cloud. Downloads models on first use."
    />
  );
  const ownKeyCard = (
    <ModeCard
      active={mode === "cloud"}
      onClick={() => setMode("cloud")}
      icon={Cloud}
      title={publikOffered ? "Use my own key" : "Bring your own key"}
      body="Use your OpenAI or Anthropic key for the highest-quality notes, quizzes, chat, and voices. You pay your provider directly — no NitroAI subscription, ever."
    />
  );
  const keyField = mode === "cloud" && (
    <div className="mt-6 w-full max-w-3xl">
      <div className="flex items-center gap-2 rounded-xl border border-edge bg-card px-4 py-3 shadow-soft">
        <KeyRound className="size-4 text-ink-faint" />
        <input
          autoFocus
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-... or sk-ant-..."
          className="w-full bg-transparent text-sm outline-none placeholder:text-ink-faint"
        />
        {provider && (
          <span className="shrink-0 rounded-full bg-accent-softer px-3 py-1 text-xs font-bold text-accent">
            {provider === "anthropic" ? "Anthropic" : provider === "publik" ? "publik API" : "OpenAI"}
          </span>
        )}
      </div>
      <p className="mt-2 text-xs text-ink-faint">
        Stored only on this computer. One key powers every feature.
      </p>
    </div>
  );
  const setupModal = setupOpen && (
    <LocalSetupModal
      models={{ chatModel: getEnginePrefs().localModel || undefined }}
      onDone={(chatModel) => enter("local", chatModel)}
      onCancel={() => {
        setSetupOpen(false);
        setBusy(false);
        setMode("cloud");
      }}
    />
  );

  if (publikOffered) {
    return (
      <div className="flex h-full flex-col items-center overflow-y-auto bg-bg px-6 py-10">
        <div className="my-auto flex w-full max-w-3xl flex-col items-center">
          <div className="flex items-center gap-2">
            <PenLine className="size-7 text-accent" />
            <span className="font-display text-2xl font-bold tracking-tight">nitro ai</span>
          </div>
          <div className="mt-8 w-full" data-testid="publik-first">
            <PublikDisclosure busy={busy} error={publikError} onContinue={continueWithPublik} />
          </div>
          <div className="mt-6 w-full">
            <button
              type="button"
              onClick={() => setOthersOpen((o) => !o)}
              aria-expanded={othersOpen}
              className="inline-flex items-center gap-1 text-sm font-semibold text-ink-dim hover:text-ink"
            >
              {othersOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
              {otherWays.label}
            </button>
            {othersOpen && (
              <div data-testid="other-ways">
                <div className="mt-4 grid w-full gap-4 md:grid-cols-2">
                  {localCard}
                  {ownKeyCard}
                </div>
                {keyField}
                {mode && (
                  <button
                    onClick={finish}
                    disabled={!ready || busy}
                    className={`mt-6 w-full rounded-xl border py-3 font-display font-bold transition ${
                      ready && !busy
                        ? "border-edge bg-panel text-ink hover:bg-card-hover"
                        : "cursor-not-allowed border-edge bg-panel text-ink-faint"
                    }`}
                  >
                    {busy ? "Setting up…" : "Get started"}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        {setupModal}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center bg-bg px-6">
      <div className="flex items-center gap-2">
        <PenLine className="size-7 text-accent" />
        <span className="font-display text-2xl font-bold tracking-tight">nitro ai</span>
      </div>
      <h1 className="mt-6 text-center font-display text-4xl font-bold">
        How do you want your AI to run?
      </h1>
      <p className="mt-2 max-w-lg text-center text-ink-dim">
        Pick the engine that fits you. There's no wrong answer — you can switch
        anytime in Settings.
      </p>

      <div className="mt-10 grid w-full max-w-3xl gap-4 md:grid-cols-2">
        {localCard}
        {ownKeyCard}
      </div>

      {keyField}

      <button
        onClick={finish}
        disabled={!ready || busy}
        className={`mt-10 w-full max-w-3xl rounded-xl py-3.5 font-display font-bold transition ${
          ready && !busy
            ? "bg-accent text-white hover:bg-accent-hover"
            : "cursor-not-allowed bg-accent-softer text-ink-faint"
        }`}
      >
        {busy ? "Setting up…" : "Get started"}
      </button>

      {setupModal}
    </div>
  );
}

function ModeCard({
  active,
  onClick,
  icon: Icon,
  title,
  body,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Cpu;
  title: string;
  body: string;
  badge?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative rounded-card border-2 p-6 text-left shadow-soft transition ${
        active ? "border-accent bg-accent-softer" : "border-edge bg-card hover:bg-card-hover"
      }`}
    >
      {badge && (
        <span className="absolute right-4 top-4 rounded-full bg-accent px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
          {badge}
        </span>
      )}
      <Icon className={`size-7 ${active ? "text-accent" : "text-ink-dim"}`} />
      <h2 className="mt-3 font-display text-xl font-bold">{title}</h2>
      <p className="mt-1.5 text-sm text-ink-dim">{body}</p>
    </button>
  );
}
