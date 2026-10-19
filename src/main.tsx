import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@fontsource-variable/quicksand";
import "@fontsource/nunito/400.css";
import "@fontsource/nunito/600.css";
import "@fontsource/nunito/700.css";
import "katex/dist/katex.min.css";
import "./styles/theme.css";
import App from "./App";
import { AppProvider } from "./lib/app";
import { ToastProvider } from "./components/ui/Toast";
import { applyTheme, getTheme } from "./lib/theme";

applyTheme(getTheme());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <BrowserRouter>
      <AppProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </AppProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
