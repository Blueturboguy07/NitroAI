// @vitest-environment jsdom
/* Settings with publik API: the user's own key is never overwritten or
   forgotten by any publik path; the balance line comes from GET /wallet. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stubServer(status: Record<string, unknown>, wallet: Record<string, unknown> | null = null) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url === "/api/publik/status") return json(status);
      if (url === "/api/publik/wallet") return wallet ? json(wallet) : json({ error: { type: "no_publik_credential" } }, 404);
      if (url === "/api/publik/provision") return json({ ok: true, minted: true, ...status, state: "ready" });
      if (url === "/api/publik/forget" || url === "/api/publik/disconnect") return json({ ok: true, available: true, state: "unprovisioned", baseUrl: "/api/publik/v1" });
      if (url.startsWith("/api/local/status")) return json({ installed: false, serving: false, hasChatModel: false, hasEmbedModel: false, models: [] });
      return new Response("not found", { status: 404 });
    }),
  );
  return calls;
}

async function renderSettings() {
  const { AppProvider } = await import("../lib/app");
  const { default: Settings } = await import("./Settings");
  render(
    <MemoryRouter>
      <AppProvider>
        <Settings />
      </AppProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Settings — publik API", () => {
  it("switching the pill to publik and back leaves the user's key exactly as it was; Remove key never touches publik", async () => {
    localStorage.setItem("nitroai.apikey", "sk-user-key");
    localStorage.setItem("nitroai.prefs", JSON.stringify({ mode: "cloud", onboarded: true, language: "English" }));
    const calls = stubServer({ available: true, state: "unprovisioned", baseUrl: "/api/publik/v1" });
    await renderSettings();
    const user = userEvent.setup();

    const input = (await screen.findByPlaceholderText(/pk_… \(publik API\)/)) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("sk-user-key"));

    await user.click(await screen.findByRole("button", { name: "publik API" }));
    expect(await screen.findByRole("heading", { name: "NitroAI uses publik API" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Use my own key instead" }));

    const again = (await screen.findByPlaceholderText(/pk_… \(publik API\)/)) as HTMLInputElement;
    expect(again.value).toBe("sk-user-key");
    expect(localStorage.getItem("nitroai.apikey")).toBe("sk-user-key");
    expect(JSON.parse(localStorage.getItem("nitroai.prefs")!).mode).toBe("cloud");

    await user.click(screen.getByRole("button", { name: "Remove key" }));
    await waitFor(() => expect(localStorage.getItem("nitroai.apikey")).toBeNull());
    expect(calls).not.toContain("/api/publik/forget");
    expect(calls).not.toContain("/api/publik/disconnect");
    expect(calls).not.toContain("/api/publik/provision");
  });

  it("renders the balance line from GET /wallet and the link button while anonymous", async () => {
    localStorage.setItem("nitroai.apikey", "sk-user-key-untouched");
    localStorage.setItem("nitroai.prefs", JSON.stringify({ mode: "publik", onboarded: true, language: "English", publikDisclosureAck: 2 }));
    stubServer(
      { available: true, state: "ready", baseUrl: "/api/publik/v1", models: { fast: "publik-fast", balanced: "publik-balanced" }, claimUrl: "https://publikhq.com/claim/HK7F-2QWD", starterMicros: 250000 },
      { balance_micros: 4_870_000, claim_state: "anonymous", week: { used_micros: 130_000, budget_micros: null, resets_at: "2026-09-25T17:04:11Z" }, claim_url: "https://publikhq.com/claim/HK7F-2QWD" },
    );
    await renderSettings();
    const line = await screen.findByTestId("publik-balance-line");
    await waitFor(() => expect(line).toHaveTextContent("$4.87 left · $0.13 used this week"));
    expect(screen.getByRole("button", { name: /Link this computer to your publik account/ })).toBeInTheDocument();
    expect(screen.getByText(/passed through at cost/)).toBeInTheDocument();
    expect(localStorage.getItem("nitroai.apikey")).toBe("sk-user-key-untouched");
  });

  it("without a build token the publik pill is absent and the page reads as before", async () => {
    localStorage.setItem("nitroai.prefs", JSON.stringify({ mode: "local", onboarded: true, language: "English" }));
    stubServer({ available: false, state: "unprovisioned", baseUrl: "/api/publik/v1" });
    await renderSettings();
    await screen.findByRole("button", { name: "Local" });
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/publik/status", expect.anything()));
    expect(screen.queryByRole("button", { name: "publik API" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cloud" })).toBeInTheDocument();
  });
});
