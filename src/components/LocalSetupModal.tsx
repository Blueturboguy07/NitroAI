import { useEffect, useRef, useState } from "react";
import { Cpu, Loader2, TriangleAlert } from "lucide-react";
import { runLocalSetup, type LocalSetupEvent } from "../lib/localSetup";

/* Progress UI for provisioning the local engine. Runs the setup stream once on
   mount; calls onDone when the local AI is ready, or surfaces an error with a
   retry. Shown only after the user has chosen the local engine. */
export default function LocalSetupModal({
  onDone,
  onCancel,
}: {
  onDone: () => void;
  onCancel: () => void;
}) {
  const [message, setMessage] = useState("Preparing your local AI…");
  const [detail, setDetail] = useState<string>("");
  const [percent, setPercent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const started = useRef(false);

  useEffect(() => {
    started.current = false;
    setError(null);
    const controller = new AbortController();
    if (started.current) return;
    started.current = true;

    const label = (e: LocalSetupEvent): string => {
      switch (e.phase) {
        case "installing":
          return "Setting up the local AI runtime…";
        case "starting":
          return "Starting the local AI runtime…";
        case "pulling":
          return e.model ? `Downloading model ${e.model}…` : "Downloading models…";
        case "ready":
        case "done":
          return "Local AI is ready.";
        default:
          return e.message || "Working…";
      }
    };

    runLocalSetup((e) => {
      setMessage(label(e));
      setPercent(typeof e.percent === "number" ? e.percent : null);
      setDetail(e.model && e.message && e.message !== e.model ? `${e.model} · ${e.message}` : "");
    }, controller.signal)
      .then(onDone)
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Local setup failed.");
      });

    return () => controller.abort();
  }, [attempt, onDone]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[460px] max-w-[90vw] rounded-modal bg-card p-8 shadow-modal">
        {error ? (
          <>
            <div className="flex items-center gap-3">
              <TriangleAlert className="size-6 text-danger-ink" />
              <h2 className="font-display text-xl font-bold">Couldn't set up local AI</h2>
            </div>
            <p className="mt-3 text-sm text-ink-dim">{error}</p>
            <div className="mt-6 flex gap-3">
              <button
                onClick={onCancel}
                className="flex-1 rounded-xl bg-panel py-3 font-display font-semibold text-ink-dim hover:bg-card-hover"
              >
                Use a cloud key instead
              </button>
              <button
                onClick={() => setAttempt((a) => a + 1)}
                className="flex-1 rounded-xl bg-accent py-3 font-display font-bold text-white hover:bg-accent-hover"
              >
                Try again
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <span className="flex size-11 items-center justify-center rounded-2xl bg-accent-softer">
                <Cpu className="size-6 text-accent" />
              </span>
              <div>
                <h2 className="font-display text-lg font-bold">Setting up local AI</h2>
                <p className="text-xs text-ink-faint">One-time download. Nothing to install by hand.</p>
              </div>
            </div>

            <div className="mt-6 flex items-center gap-2.5 text-sm text-ink">
              <Loader2 className="size-4 animate-spin text-accent" />
              <span>{message}</span>
            </div>
            {detail && <p className="mt-1 pl-6 text-xs text-ink-faint">{detail}</p>}

            {percent !== null && (
              <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-panel">
                <div
                  className="h-full rounded-full bg-accent transition-all"
                  style={{ width: `${percent}%` }}
                />
              </div>
            )}
            <p className="mt-5 text-xs text-ink-faint">
              This can take a few minutes on the first run while the model downloads.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
