import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Cloud, Cpu, KeyRound, PenLine, Zap } from "lucide-react";
import { detectProvider, saveApiKey } from "../lib/engine/keys";
import { getEnginePrefs } from "../lib/prefs";
import { localSetupStatus } from "../lib/localSetup";
import { fetchPublikStatus, provisionPublik, type PublikStatus } from "../lib/publik";
import { DISCLOSURE_VERSION, onboardingCard, settings as publikCopy } from "../lib/publikCopy";
import LocalSetupModal from "../components/LocalSetupModal";
import { PublikDisclosure } from "../components/PublikNotice";
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

export default function Onboarding() {
  const navigate = useNavigate();
  const { savePrefs } = useApp();
  /* publik API is preselected when this build can offer it (a token was
     baked in at build time, or a credential already exists). Otherwise the
     page is exactly the two-card page it always was: the user must choose. */
  const [publik, setPublik] = useState<PublikStatus | null>(null);
  const [mode, setMode] = useState<EngineMode | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [publikError, setPublikError] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const provider = detectProvider(apiKey.trim());
  const ready = mode === "local" || (mode === "cloud" && provider !== null);
  const publikOffered = publik?.available === true;

  useEffect(() => {
    let alive = true;
    fetchPublikStatus().then((s) => {
      if (!alive) return;
      setPublik(s);
      setMode((m) => (m === null && s.available ? "publik" : m));
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

  /* "Continue with publik API" — the consent that triggers the mint. Nothing
     is typed, nothing is written to the user's own key slot. */
  async function continueWithPublik() {
    if (busy) return;
    setBusy(true);
    setPublikError(null);
    const r = await provisionPublik(DISCLOSURE_VERSION, publik?.state === "disconnected");
    if (r.ok && r.state === "ready") {
      enter("publik");
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

      <div className={`mt-10 grid w-full max-w-3xl gap-4 ${publikOffered ? "md:grid-cols-3" : "md:grid-cols-2"}`}>
        {publikOffered && (
          <ModeCard
            active={mode === "publik"}
            onClick={() => setMode("publik")}
            icon={Zap}
            title={onboardingCard.title}
            badge={onboardingCard.badge}
            body={onboardingCard.body}
          />
        )}
        <ModeCard
          active={mode === "local"}
          onClick={() => setMode("local")}
          icon={Cpu}
          title="Fully local"
          body="Everything runs on this device — private, offline, zero cost. Best for privacy; long lectures and quiz distractors are a little weaker than cloud. Downloads models on first use."
        />
        <ModeCard
          active={mode === "cloud"}
          onClick={() => setMode("cloud")}
          icon={Cloud}
          title={publikOffered ? "Use my own key" : "Bring your own key"}
          body="Use your OpenAI or Anthropic key for the highest-quality notes, quizzes, chat, and voices. You pay your provider directly — no NitroAI subscription, ever."
        />
      </div>

      {mode === "publik" && publikOffered && (
        <div className="mt-6 w-full max-w-3xl">
          <PublikDisclosure
            busy={busy}
            error={publikError}
            onContinue={continueWithPublik}
            onOwnKey={() => {
              setPublikError(null);
              setMode("cloud");
            }}
          />
        </div>
      )}

      {mode === "cloud" && (
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
      )}

      {mode !== "publik" && (
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
      )}

      {setupOpen && (
        <LocalSetupModal
          models={{ chatModel: getEnginePrefs().localModel || undefined }}
          onDone={(chatModel) => enter("local", chatModel)}
          onCancel={() => {
            setSetupOpen(false);
            setBusy(false);
            setMode("cloud");
          }}
        />
      )}
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
