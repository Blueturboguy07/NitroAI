import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Loader2 } from "lucide-react";
import AppShell from "./components/AppShell";
import Dashboard from "./pages/Dashboard";
import Settings from "./pages/Settings";
import NoteView from "./pages/NoteView";
import Onboarding from "./pages/Onboarding";
import { useApp } from "./lib/app";

export default function App() {
  const location = useLocation();
  const { ready, prefs } = useApp();

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center gap-2.5 bg-bg text-ink-faint">
        <Loader2 className="size-5 animate-spin text-accent" />
        <span className="font-display">Loading NitroAI…</span>
      </div>
    );
  }

  if (!prefs.onboarded && location.pathname !== "/onboarding") {
    return <Navigate to="/onboarding" replace />;
  }

  return (
    <Routes>
      <Route path="/onboarding" element={<Onboarding />} />
      <Route element={<AppShell />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
      <Route path="/notes/:id" element={<Navigate to="editor" replace />} />
      <Route path="/notes/:id/:view" element={<NoteView />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
