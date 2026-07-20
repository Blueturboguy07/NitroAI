import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Cloud, Cpu, KeyRound, PenLine } from "lucide-react";
import { detectProvider, saveApiKey } from "../lib/engine/keys";
import { getEnginePrefs } from "../lib/prefs";
import { localSetupStatus } from "../lib/localSetup";
import LocalSetupModal from "../components/LocalSetupModal";
import { useApp } from "../lib/app";
import type { EngineMode } from "../lib/types";

export default function Onboarding() {
  const navigate = useNavigate();
  const { savePrefs } = useApp();
  /* No default — the user must make an explicit choice. */
  const [mode, setMode] = useState<EngineMode | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const provider = detectProvider(apiKey.trim());
  const ready = mode === "local" || (mode === "cloud" && provider !== null);

  function enter(nextMode: EngineMode) {
    savePrefs({ ...getEnginePrefs(), mode: nextMode, onboarded: true });
    navigate("/", { replace: true });
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
    // use a manually-running Ollama.
    const status = await localSetupStatus();
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

      <div className="mt-10 grid w-full max-w-3xl gap-4 md:grid-cols-2">
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
          title="Bring your own key"
          body="Use your OpenAI or Anthropic key for the highest-quality notes, quizzes, chat, and voices. You pay your provider directly — no NitroAI subscription, ever."
        />
      </div>

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
                {provider === "anthropic" ? "Anthropic" : "OpenAI"}
              </span>
            )}
          </div>
          <p className="mt-2 text-xs text-ink-faint">
            Stored in your system keychain. One key powers every feature.
          </p>
        </div>
      )}

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

      {setupOpen && (
        <LocalSetupModal
          onDone={() => enter("local")}
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
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Cpu;
  title: string;
  body: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative rounded-card border-2 p-6 text-left shadow-soft transition ${
        active ? "border-accent bg-accent-softer" : "border-edge bg-card hover:bg-card-hover"
      }`}
    >
      <Icon className={`size-7 ${active ? "text-accent" : "text-ink-dim"}`} />
      <h2 className="mt-3 font-display text-xl font-bold">{title}</h2>
      <p className="mt-1.5 text-sm text-ink-dim">{body}</p>
    </button>
  );
}
