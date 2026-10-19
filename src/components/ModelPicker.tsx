/* Settings → "My own key" → Models. Lets the user choose which of their
   provider's models runs each tier: the main model (notes, flashcards,
   quizzes, podcast scripts) and the fast model (chat, titles, topic lists).
   The list comes live from the provider for the saved key; any id can also
   be typed by hand, so a brand-new or preview model never needs an update. */

import { useEffect, useState } from "react";
import { Layers, RefreshCw } from "lucide-react";
import { listModels, defaultModelLabel, type Tier } from "../lib/engine/models";
import { PROVIDER_LABELS } from "../lib/engine/keys";
import type { ModelInfo } from "../lib/engine/types";
import type { ModelChoice, Provider } from "../lib/types";

const CUSTOM = "__custom__";

const TIERS: { tier: Tier; label: string; hint: string }[] = [
  { tier: "strong", label: "Main model", hint: "Notes, flashcards, quizzes and podcast scripts" },
  { tier: "fast", label: "Fast model", hint: "Chat answers, titles and topic lists" },
];

export default function ModelPicker({
  provider,
  apiKey,
  choice,
  onChange,
}: {
  provider: Provider;
  apiKey: string;
  choice: ModelChoice;
  onChange: (next: ModelChoice) => void;
}) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError("");
    listModels(provider, apiKey, ctrl.signal)
      .then((m) => setModels(m))
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setModels([]);
        setError(e instanceof Error ? e.message : "Couldn't load the model list.");
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [provider, apiKey, reloads]);

  return (
    <div className="mt-5 rounded-xl border border-edge bg-panel p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <Layers className="size-4 text-accent" />
          Models
        </p>
        <button
          onClick={() => setReloads((n) => n + 1)}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-lg border border-edge bg-card px-2.5 py-1 text-xs font-semibold text-ink-dim shadow-soft hover:text-ink disabled:opacity-60"
        >
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
          Refresh list
        </button>
      </div>
      <p className="mt-1 text-sm text-ink-faint">
        Choose which {PROVIDER_LABELS[provider]} models NitroAI uses. Pick the same model twice to use
        one model for everything.
      </p>

      <div className="mt-3 space-y-3">
        {TIERS.map(({ tier, label, hint }) => (
          <TierSelect
            key={tier}
            label={label}
            hint={hint}
            value={choice[tier] ?? ""}
            defaultLabel={defaultModelLabel(provider, tier)}
            models={models}
            onChange={(id) => onChange({ ...choice, [tier]: id })}
          />
        ))}
      </div>

      <p className={`mt-3 text-xs ${error ? "font-semibold text-danger-ink" : "text-ink-faint"}`}>
        {loading
          ? "Loading the models this key can use…"
          : error
            ? `Couldn't load the model list (${error}). You can still type a model id with "Custom model id…".`
            : `${models.length} model${models.length === 1 ? "" : "s"} available to this key.`}
      </p>
    </div>
  );
}

function TierSelect({
  label,
  hint,
  value,
  defaultLabel,
  models,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  defaultLabel: string;
  models: ModelInfo[];
  onChange: (id: string) => void;
}) {
  const known = value === "" || models.some((m) => m.id === value);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => setDraft(value), [value]);

  function commit() {
    const id = draft.trim();
    setEditing(false);
    if (id !== value) onChange(id);
  }

  return (
    <div>
      <span className="text-xs font-semibold text-ink-dim">{label}</span>
      <span className="ml-1.5 text-xs text-ink-faint">— {hint}</span>
      <select
        aria-label={label}
        value={editing ? CUSTOM : value}
        onChange={(e) => {
          if (e.target.value === CUSTOM) {
            setDraft(value);
            setEditing(true);
            return;
          }
          setEditing(false);
          onChange(e.target.value);
        }}
        className="mt-1.5 w-full rounded-xl border border-edge bg-card px-3 py-2.5 text-sm outline-none focus:border-accent"
      >
        <option value="">Default ({defaultLabel})</option>
        {!known && <option value={value}>{value} (custom)</option>}
        {models.length > 0 && (
          <optgroup label="Available to this key">
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label && m.label !== m.id ? `${m.label} — ${m.id}` : m.id}
              </option>
            ))}
          </optgroup>
        )}
        <option value={CUSTOM}>Custom model id…</option>
      </select>
      {editing && (
        <div className="mt-2 flex items-center gap-2">
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              }
              if (e.key === "Escape") setEditing(false);
            }}
            placeholder="Exact model id, e.g. gemini-3.8-flash"
            className="w-full rounded-xl border border-edge bg-card px-3 py-2 text-sm outline-none focus:border-accent"
          />
          <button
            onClick={commit}
            className="shrink-0 rounded-xl bg-accent px-3 py-2 text-sm font-bold text-white hover:bg-accent-hover"
          >
            Use
          </button>
        </div>
      )}
    </div>
  );
}
