import { useEffect, useState } from "react";
import {
  Camera,
  CheckCircle2,
  Copy,
  Cpu,
  Download,
  KeyRound,
  Pencil,
  Settings as SettingsIcon,
} from "lucide-react";
import { useApp } from "../lib/app";
import {
  clearApiKey,
  detectProvider,
  loadApiKey,
  saveApiKey,
} from "../lib/engine/keys";
import { createEngine } from "../lib/engine";
import { localSetupStatus } from "../lib/localSetup";
import LocalSetupModal from "../components/LocalSetupModal";
import { exportMarkdown, downloadText } from "../lib/export";
import type { EngineMode } from "../lib/types";

const DATA_FOLDER =
  typeof navigator !== "undefined" && navigator.platform.startsWith("Win")
    ? "%APPDATA%\\NitroAI"
    : "~/Library/Application Support/NitroAI";

export default function Settings() {
  const { prefs, savePrefs, repo } = useApp();
  const [key, setKey] = useState("");
  const [exportMsg, setExportMsg] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [msg, setMsg] = useState("");
  const [localSetup, setLocalSetup] = useState(false);
  const provider = detectProvider(key.trim());

  useEffect(() => {
    loadApiKey().then(setKey);
  }, []);

  function setMode(mode: EngineMode) {
    if (mode === "local") {
      // Switching to local provisions Ollama the same way onboarding does —
      // install/start/pull as needed — before the engine is used.
      void localSetupStatus().then((s) => {
        const ready = s?.serving && s.hasChatModel && s.hasEmbedModel;
        if (s && !ready) {
          setLocalSetup(true);
          return;
        }
        savePrefs({ ...prefs, mode });
      });
      return;
    }
    savePrefs({ ...prefs, mode });
  }

  async function saveKey() {
    setStatus("saving");
    setMsg("");
    try {
      const p = detectProvider(key.trim());
      if (!p) throw new Error("Key must start with sk- (OpenAI) or sk-ant- (Anthropic).");
      await createEngine({ mode: "cloud", provider: p, apiKey: key.trim() }).validate();
      await saveApiKey(key.trim());
      savePrefs({ ...prefs, mode: "cloud" });
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 2500);
    } catch (e) {
      setStatus("error");
      setMsg(e instanceof Error ? e.message : "Could not validate the key.");
    }
  }

  return (
    <div className="px-10 py-8">
      <div className="flex items-center gap-3">
        <SettingsIcon className="size-6 text-accent" />
        <h1 className="text-4xl font-bold tracking-tight">Settings</h1>
      </div>
      <p className="mt-1 text-lg text-ink-faint">Manage your profile, engine, and preferences</p>

      <div className="mt-8 grid gap-6 lg:grid-cols-[380px_1fr]">
        <div className="overflow-hidden rounded-card border border-edge bg-card shadow-soft">
          <div className="h-24 bg-accent-soft" />
          <div className="-mt-10 flex flex-col items-center px-6 pb-6">
            <div className="relative">
              <div className="flex size-20 items-center justify-center rounded-full border-4 border-card bg-accent-softer font-display text-2xl font-bold text-accent">
                N
              </div>
              <button
                className="absolute -bottom-1 -left-1 rounded-full border border-edge bg-card p-1.5 text-ink-dim shadow-soft hover:text-ink"
                aria-label="Change avatar"
              >
                <Camera className="size-3.5" />
              </button>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <span className="font-display text-xl font-bold">You</span>
              <Pencil className="size-3.5 text-ink-faint" />
            </div>
            <span className="text-sm text-ink-faint">
              Local account — nothing leaves this device
            </span>

            <div className="mt-5 w-full space-y-3">
              <Field label="Language" value={prefs.language} editable />
              <Field label="Data folder" value={DATA_FOLDER} copyable />
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-card border border-edge bg-card p-6 shadow-soft">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="flex items-center gap-2 font-display text-xl font-bold">
                  <Cpu className="size-5 text-accent" />
                  AI Engine
                </h2>
                <p className="mt-1 text-sm text-ink-faint">
                  Run everything locally for free, or bring your own API key for
                  cloud-quality output.
                </p>
              </div>
              <div className="flex rounded-full border border-edge bg-panel p-1">
                {(
                  [
                    ["local", "Local"],
                    ["cloud", "Cloud"],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => setMode(k as EngineMode)}
                    className={`rounded-full px-4 py-1.5 text-sm font-semibold ${
                      prefs.mode === k ? "bg-accent text-white" : "text-ink-faint hover:text-ink"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {prefs.mode === "cloud" ? (
              <div className="mt-5">
                <label className="text-sm font-semibold text-ink-dim">API key</label>
                <div className="mt-1.5 flex items-center gap-2 rounded-xl border border-edge bg-panel px-3 py-2.5">
                  <KeyRound className="size-4 text-ink-faint" />
                  <input
                    type="password"
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    placeholder="sk-... (OpenAI) or sk-ant-... (Anthropic) — auto-detected"
                    className="w-full bg-transparent text-sm outline-none placeholder:text-ink-faint"
                  />
                  {provider && (
                    <span className="shrink-0 rounded-full bg-accent-softer px-2.5 py-1 text-xs font-bold text-accent">
                      {provider === "anthropic" ? "Anthropic" : "OpenAI"}
                    </span>
                  )}
                </div>
                <div className="mt-3 flex items-center gap-3">
                  <button
                    onClick={saveKey}
                    disabled={status === "saving"}
                    className="rounded-xl bg-accent px-4 py-2 text-sm font-bold text-white hover:bg-accent-hover disabled:opacity-60"
                  >
                    {status === "saving" ? "Validating…" : "Save & validate"}
                  </button>
                  {status === "saved" && (
                    <span className="flex items-center gap-1 text-sm font-semibold text-green-600">
                      <CheckCircle2 className="size-4" /> Saved
                    </span>
                  )}
                  {key && (
                    <button
                      onClick={async () => {
                        await clearApiKey();
                        setKey("");
                      }}
                      className="text-sm font-semibold text-ink-faint hover:text-danger-ink"
                    >
                      Remove key
                    </button>
                  )}
                </div>
                {status === "error" && (
                  <p className="mt-2 text-xs font-semibold text-danger-ink">{msg}</p>
                )}
                <p className="mt-2 text-xs text-ink-faint">
                  Stored in your system keychain, never in app files. One key powers
                  every feature.
                </p>
              </div>
            ) : (
              <div className="mt-5 rounded-xl border border-edge bg-panel p-4">
                <p className="text-sm font-semibold">Local models</p>
                <p className="mt-1 text-sm text-ink-faint">
                  Speech-to-text, note generation, podcast voices, and search run on
                  this device via a local runtime (Ollama for text; Whisper &amp;
                  Kokoro for audio). Start Ollama, or switch to a cloud key for the
                  audio features.
                </p>
              </div>
            )}
          </div>

          <div className="rounded-card border border-edge bg-card p-6 shadow-soft">
            <h2 className="flex items-center gap-2 font-display text-xl font-bold">
              <Download className="size-5 text-accent" />
              Your data
            </h2>
            <p className="mt-1 text-sm text-ink-faint">
              NitroAI is free and open source (AGPL-3.0). Your notes are yours —
              export any single note as Markdown, PDF, or Word from its menu, or
              export everything at once here. Nothing is ever locked behind a paywall.
            </p>
            <div className="mt-4 flex items-center gap-3">
              <button
                onClick={async () => {
                  const notes = (await repo?.listNotes()) ?? [];
                  if (notes.length === 0) {
                    setExportMsg("You don't have any notes yet.");
                    return;
                  }
                  const all = notes.map((n) => exportMarkdown(n)).join("\n\n---\n\n");
                  downloadText("nitroai-notes.md", all, "text/markdown");
                  setExportMsg(`Exported ${notes.length} note${notes.length > 1 ? "s" : ""}.`);
                }}
                className="rounded-xl border border-edge bg-panel px-4 py-2 text-sm font-semibold shadow-soft hover:bg-card-hover"
              >
                Export all notes (Markdown)
              </button>
              {exportMsg && <span className="text-sm text-ink-faint">{exportMsg}</span>}
            </div>
          </div>
        </div>
      </div>

      {localSetup && (
        <LocalSetupModal
          onDone={() => {
            setLocalSetup(false);
            savePrefs({ ...prefs, mode: "local" });
          }}
          onCancel={() => setLocalSetup(false)}
        />
      )}
    </div>
  );
}

function Field({
  label,
  value,
  editable,
  copyable,
}: {
  label: string;
  value: string;
  editable?: boolean;
  copyable?: boolean;
}) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-edge bg-panel px-4 py-3">
      <div className="min-w-0">
        <p className="text-xs font-semibold text-ink-faint">{label}</p>
        <p className="truncate text-sm font-semibold">{value}</p>
      </div>
      {editable && <Pencil className="size-3.5 shrink-0 text-ink-faint" />}
      {copyable && (
        <button
          onClick={() => navigator.clipboard.writeText(value)}
          className="rounded-lg border border-edge bg-card p-2 text-ink-dim shadow-soft hover:text-ink"
          aria-label={`Copy ${label}`}
        >
          <Copy className="size-3.5" />
        </button>
      )}
    </div>
  );
}
