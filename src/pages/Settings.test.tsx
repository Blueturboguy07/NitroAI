// @vitest-environment jsdom
/* Settings with publik API: publik leads the AI Engine card with ONE primary
   button, Local and the user's own key sit below in a closed section
   (founder 2026-11-02 "publik api should be front and center"); the user's
   own key is never overwritten or forgotten by any publik path; the balance
   line comes from GET /wallet. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
  // jsdom has no window.open; a fresh mint opens the claim page.
  vi.stubGlobal("open", vi.fn());
});

/* The AI Engine card and the buttons drawn in it as the primary action. */
const engineCard = () => screen.getByRole("heading", { name: "AI Engine" }).closest(".rounded-card") as HTMLElement;
const primaryButtons = (root: HTMLElement) =>
  Array.from(root.querySelectorAll("button")).filter((b) => b.className.split(/\s+/).includes("bg-accent"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Settings — publik API", () => {
  it("publik leads the AI Engine card with ONE primary button; the user's key sits below, closed and untouched; Remove key never touches publik", async () => {
    localStorage.setItem("nitroai.apikey", "sk-user-key");
    localStorage.setItem("nitroai.prefs", JSON.stringify({ mode: "cloud", onboarded: true, language: "English" }));
    const calls = stubServer({ available: true, state: "unprovisioned", baseUrl: "/api/publik/v1" });
    await renderSettings();
    const user = userEvent.setup();

    expect(await screen.findByRole("heading", { name: "NitroAI uses publik API" })).toBeInTheDocument();
    const card = engineCard();
    // On their own key the intro says so (it used to say "NitroAI runs on publik API").
    expect(card).toHaveTextContent("NitroAI now runs on your own API key.");
    expect(card).not.toHaveTextContent("NitroAI runs on publik API");
    expect(primaryButtons(card)).toEqual([screen.getByRole("button", { name: "Continue with publik API" })]);
    // No pill of three, no own-key link next to Continue, no key field until opened.
    expect(screen.queryByRole("button", { name: "publik API" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use my own key instead" })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/pk_… \(publik API\)/)).not.toBeInTheDocument();
    const others = screen.getByRole("button", { name: "Other ways to run NitroAI: your own key, or fully local" });
    expect(others).toHaveAttribute("aria-expanded", "false");
    expect(card).toHaveTextContent("Now running on your own key.");
    expect(card.textContent!.indexOf("NitroAI uses publik API")).toBeLessThan(card.textContent!.indexOf("Other ways to run NitroAI"));

    await user.click(others);
    expect(others).toHaveAttribute("aria-expanded", "true");
    const input = (await screen.findByPlaceholderText(/pk_… \(publik API\)/)) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("sk-user-key"));
    expect(localStorage.getItem("nitroai.apikey")).toBe("sk-user-key");
    expect(JSON.parse(localStorage.getItem("nitroai.prefs")!).mode).toBe("cloud");

    await user.click(screen.getByRole("button", { name: "Remove key" }));
    await waitFor(() => expect(localStorage.getItem("nitroai.apikey")).toBeNull());
    expect(calls).not.toContain("/api/publik/forget");
    expect(calls).not.toContain("/api/publik/disconnect");
    expect(calls).not.toContain("/api/publik/provision");
  });

  it("one press in Settings: Continue mints, opens the claim page and switches to publik; the user's key stays", async () => {
    localStorage.setItem("nitroai.apikey", "sk-user-key");
    localStorage.setItem("nitroai.prefs", JSON.stringify({ mode: "cloud", onboarded: true, language: "English" }));
    const calls = stubServer({ available: true, state: "unprovisioned", baseUrl: "/api/publik/v1", claimUrl: "https://publikhq.com/claim/HK7F-2QWD", starterMicros: 0 });
    const open = vi.fn();
    vi.stubGlobal("open", open);
    await renderSettings();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Continue with publik API" }));
    await screen.findByTestId("publik-welcome-card");
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("https://publikhq.com/claim/HK7F-2QWD", "_blank", "noopener");
    expect(screen.getByTestId("publik-link-opened")).toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(localStorage.getItem("nitroai.prefs")!)).toMatchObject({ mode: "publik", publikDisclosureAck: 2 }));
    expect(calls.filter((c) => c === "/api/publik/provision")).toHaveLength(1);
    expect(localStorage.getItem("nitroai.apikey")).toBe("sk-user-key");
  });

  it("a ready publik credential while on Local shows ONE primary 'Use publik API'; it switches back without a new mint", async () => {
    localStorage.setItem("nitroai.prefs", JSON.stringify({ mode: "local", onboarded: true, language: "English", publikDisclosureAck: 2 }));
    const calls = stubServer(
      { available: true, state: "ready", baseUrl: "/api/publik/v1", claimUrl: "https://publikhq.com/claim/HK7F-2QWD", starterMicros: 0 },
      { balance_micros: 1_850_000, claim_state: "claimed" },
    );
    await renderSettings();
    const user = userEvent.setup();
    const use = within(await screen.findByTestId("publik-use-card")).getByRole("button", { name: "Use publik API" });
    expect(primaryButtons(engineCard())).toEqual([use]);
    expect(engineCard()).toHaveTextContent("Now running locally on this computer.");
    expect(screen.queryByTestId("publik-balance-line")).not.toBeInTheDocument();

    await user.click(use);
    await waitFor(() => expect(JSON.parse(localStorage.getItem("nitroai.prefs")!)).toMatchObject({ mode: "publik", publikDisclosureAck: 2 }));
    await waitFor(() => expect(screen.getByTestId("publik-balance-line")).toHaveTextContent("$1.85 left"));
    expect(screen.queryByTestId("publik-use-card")).not.toBeInTheDocument();
    expect(calls).not.toContain("/api/publik/provision");
  });

  it("renders the balance line from GET /wallet and the link button while anonymous", async () => {
    localStorage.setItem("nitroai.apikey", "sk-user-key-untouched");
    localStorage.setItem("nitroai.prefs", JSON.stringify({ mode: "publik", onboarded: true, language: "English", publikDisclosureAck: 2 }));
    stubServer(
      { available: true, state: "ready", baseUrl: "/api/publik/v1", models: { fast: "publik-fast", balanced: "publik-balanced" }, claimUrl: "https://publikhq.com/claim/HK7F-2QWD", starterMicros: 0 },
      { balance_micros: 4_870_000, claim_state: "anonymous", week: { used_micros: 130_000, budget_micros: null, resets_at: "2026-09-25T17:04:11Z" }, claim_url: "https://publikhq.com/claim/HK7F-2QWD" },
    );
    await renderSettings();
    const line = await screen.findByTestId("publik-balance-line");
    await waitFor(() => expect(line).toHaveTextContent("$4.87 left · $0.13 used this week"));
    expect(screen.getByRole("button", { name: /^Pick a plan/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Manage plan/ })).not.toBeInTheDocument();
    expect(screen.getByText(/passed through at cost/)).toBeInTheDocument();
    expect(localStorage.getItem("nitroai.apikey")).toBe("sk-user-key-untouched");
  });

  it("contract §12.2: 'Pick a plan' opens claim_url while anonymous; the 'Why it costs money' toggle reveals the one justification sentence", async () => {
    localStorage.setItem("nitroai.prefs", JSON.stringify({ mode: "publik", onboarded: true, language: "English", publikDisclosureAck: 2 }));
    // Migration 0059: a new, unlinked computer is minted at $0.00.
    stubServer(
      { available: true, state: "ready", baseUrl: "/api/publik/v1", claimUrl: "https://publikhq.com/claim/HK7F-2QWD", starterMicros: 0 },
      { balance_micros: 0, claim_state: "anonymous", claim_url: "https://publikhq.com/claim/HK7F-2QWD" },
    );
    const open = vi.fn();
    vi.stubGlobal("open", open);
    await renderSettings();
    const user = userEvent.setup();

    // The $0.00 unlinked balance line says what linking gives — never "$0.00 left" alone or "$0.00 of free use".
    const line = await screen.findByTestId("publik-balance-line");
    await waitFor(() => expect(line).toHaveTextContent("$0.00 · link this computer for $0.05 of free use"));
    expect(document.body.textContent).not.toMatch(/\$0\.00 of free|free starter/);

    await user.click(await screen.findByRole("button", { name: /^Pick a plan/ }));
    expect(open).toHaveBeenCalledWith("https://publikhq.com/claim/HK7F-2QWD", "_blank", "noopener");

    expect(screen.queryByTestId("publik-why-it-costs")).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Why it costs money" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("publik-why-it-costs")).toHaveTextContent(
      "A provider charges for every request the app makes; publik pays that bill and passes it on at half the provider's list price. Nothing is charged behind your back — usage only draws from a plan or pack you choose to buy.",
    );
    await user.click(toggle);
    expect(screen.queryByTestId("publik-why-it-costs")).not.toBeInTheDocument();
  });

  it("contract §12.2: once claimed the button reads 'Manage plan' and opens the dashboard's API page", async () => {
    localStorage.setItem("nitroai.prefs", JSON.stringify({ mode: "publik", onboarded: true, language: "English", publikDisclosureAck: 2 }));
    stubServer(
      { available: true, state: "ready", baseUrl: "/api/publik/v1", claimUrl: "https://publikhq.com/claim/HK7F-2QWD", starterMicros: 0 },
      { balance_micros: 1_850_000, claim_state: "claimed", add_credit_url: "https://publikhq.com/dashboard/api/add", plan: { id: "basic", label: "Basic", monthly_micros: 8_000_000 } },
    );
    const open = vi.fn();
    vi.stubGlobal("open", open);
    await renderSettings();
    const user = userEvent.setup();
    const manage = await screen.findByRole("button", { name: /^Manage plan/ });
    expect(screen.queryByRole("button", { name: /^Pick a plan/ })).not.toBeInTheDocument();
    await user.click(manage);
    expect(open).toHaveBeenCalledWith("https://publikhq.com/dashboard/api", "_blank", "noopener");
  });

  it("an off-publikhq.com claim link is dropped: no plan button rather than a foreign link", async () => {
    localStorage.setItem("nitroai.prefs", JSON.stringify({ mode: "publik", onboarded: true, language: "English", publikDisclosureAck: 2 }));
    stubServer(
      { available: true, state: "ready", baseUrl: "/api/publik/v1", claimUrl: "https://evil.example/claim/X", starterMicros: 0 },
      { balance_micros: 0, claim_state: "anonymous", claim_url: "https://evil.example/claim/X" },
    );
    await renderSettings();
    await screen.findByRole("button", { name: "Why it costs money" });
    // No link to offer, so the $0.00 line does not promise one.
    await waitFor(() => expect(screen.getByTestId("publik-balance-line")).toHaveTextContent("$0.00 left"));
    expect(screen.getByTestId("publik-balance-line")).not.toHaveTextContent("link this computer");
    expect(screen.queryByRole("button", { name: /^Pick a plan/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Manage plan/ })).not.toBeInTheDocument();
  });

  it("an install minted before 0059 (old $0.25 starter) at $0.00 is not promised the $0.05 link grant: 0059 pays it nothing", async () => {
    localStorage.setItem("nitroai.prefs", JSON.stringify({ mode: "publik", onboarded: true, language: "English", publikDisclosureAck: 2 }));
    stubServer(
      { available: true, state: "ready", baseUrl: "/api/publik/v1", claimUrl: "https://publikhq.com/claim/HK7F-2QWD", starterMicros: 250000 },
      { balance_micros: 0, claim_state: "anonymous", claim_url: "https://publikhq.com/claim/HK7F-2QWD", starter: { remaining_micros: 0 } },
    );
    await renderSettings();
    await waitFor(() => expect(screen.getByTestId("publik-balance-line")).toHaveTextContent("$0.00 left"));
    expect(document.body.textContent).not.toMatch(/\$0\.05|link this computer for/);
    expect(await screen.findByRole("button", { name: /^Pick a plan/ })).toBeInTheDocument();
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

/* D3 (blind verify of ed78aae): after "Disconnect publik API" the panel kept
   its old "ready" status: it showed "publik API is set up on this computer"
   with "Use publik API", and that button turned on publik mode with no
   credential ("Ready · Balance loading…", uploads said "Set up your engine in
   Settings first"). This server keeps state: disconnect and forget remove the
   credential, provision makes one. */
function statefulServer(ready: Record<string, unknown>, wallet: Record<string, unknown>) {
  const none = { available: true, state: "unprovisioned", baseUrl: "/api/publik/v1" };
  const server = { status: ready as Record<string, unknown>, calls: [] as string[] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      server.calls.push(url);
      if (url === "/api/publik/status") return json(server.status);
      if (url === "/api/publik/wallet") return server.status.state === "ready" ? json(wallet) : json({ error: { type: "no_publik_credential" } }, 404);
      if (url === "/api/publik/provision") {
        server.status = { ...ready, claimUrl: "https://publikhq.com/claim/NEW1-LINK" };
        return json({ ok: true, minted: true, ...server.status });
      }
      if (url === "/api/publik/forget" || url === "/api/publik/disconnect") {
        server.status = none;
        return json({ ok: true, ...none });
      }
      if (url.startsWith("/api/local/status")) return json({ installed: false, serving: false, hasChatModel: false, hasEmbedModel: false, models: [] });
      return new Response("not found", { status: 404 });
    }),
  );
  return server;
}

describe("Settings — after Disconnect publik API (D3)", () => {
  const ready = { available: true, state: "ready", baseUrl: "/api/publik/v1", claimUrl: null, starterMicros: 0 };

  it("Disconnect shows the not-set-up state; its button sets up again and opens the link page", async () => {
    localStorage.setItem("nitroai.prefs", JSON.stringify({ mode: "publik", onboarded: true, language: "English", publikDisclosureAck: 2 }));
    const server = statefulServer(ready, { balance_micros: 1_850_000, claim_state: "claimed" });
    const open = vi.fn();
    vi.stubGlobal("open", open);
    await renderSettings();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Disconnect publik API" }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("nitroai.prefs")!).mode).toBeNull());
    const setUp = await screen.findByRole("button", { name: "Continue with publik API" });
    expect(engineCard()).not.toHaveTextContent("publik API is set up on this computer");
    expect(screen.queryByRole("button", { name: "Use publik API" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("publik-balance-line")).not.toBeInTheDocument();
    expect(primaryButtons(engineCard())).toEqual([setUp]);

    await user.click(setUp);
    await screen.findByTestId("publik-welcome-card");
    expect(server.calls.filter((c) => c === "/api/publik/provision")).toHaveLength(1);
    expect(open).toHaveBeenCalledWith("https://publikhq.com/claim/NEW1-LINK", "_blank", "noopener");
    await waitFor(() => expect(JSON.parse(localStorage.getItem("nitroai.prefs")!).mode).toBe("publik"));
  });

  it("Forget (anonymous install) also shows the not-set-up state", async () => {
    localStorage.setItem("nitroai.prefs", JSON.stringify({ mode: "publik", onboarded: true, language: "English", publikDisclosureAck: 2 }));
    statefulServer(ready, { balance_micros: 0, claim_state: "anonymous", claim_url: "https://publikhq.com/claim/OLD1-LINK" });
    await renderSettings();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Forget publik on this computer" }));
    expect(await screen.findByRole("button", { name: "Continue with publik API" })).toBeInTheDocument();
    expect(engineCard()).not.toHaveTextContent("publik API is set up on this computer");
  });

  it("'Use publik API' on an out-of-date card reads the status again: no credential → normal set-up and link, never publik mode with no credential", async () => {
    localStorage.setItem("nitroai.prefs", JSON.stringify({ mode: "local", onboarded: true, language: "English", publikDisclosureAck: 2 }));
    const server = statefulServer(ready, { balance_micros: 1_850_000, claim_state: "claimed" });
    const open = vi.fn();
    vi.stubGlobal("open", open);
    await renderSettings();
    const user = userEvent.setup();
    const use = within(await screen.findByTestId("publik-use-card")).getByRole("button", { name: "Use publik API" });

    // The credential goes away after the card was drawn (another window, a
    // disconnect from the publik account page, …).
    server.status = { available: true, state: "unprovisioned", baseUrl: "/api/publik/v1" };
    await user.click(use);

    await screen.findByTestId("publik-welcome-card");
    expect(server.calls.filter((c) => c === "/api/publik/provision")).toHaveLength(1);
    expect(open).toHaveBeenCalledWith("https://publikhq.com/claim/NEW1-LINK", "_blank", "noopener");
    await waitFor(() => expect(JSON.parse(localStorage.getItem("nitroai.prefs")!).mode).toBe("publik"));
  });
});

/* Cosmetic (blind verify): the AI Engine intro said "NitroAI runs on publik
   API…" while the user was on their own key or Local. */
describe("Settings — the AI Engine intro matches the engine in use", () => {
  const intro = () => engineCard().querySelector("h2 + p")!.textContent;
  const cases: Array<[string | null, string]> = [
    ["publik", "NitroAI runs on publik API: no key of your own needed. You pay per use from your publik balance."],
    ["cloud", "NitroAI now runs on your own API key. Your AI provider bills you for it. publik API needs no key of your own."],
    ["local", "NitroAI now runs locally on this computer, for free. publik API needs no key of your own."],
    [null, "Set up publik API to run NitroAI with no key of your own. You pay per use from your publik balance."],
  ];
  for (const [mode, text] of cases) {
    it(`mode ${String(mode)}`, async () => {
      if (mode === "cloud") localStorage.setItem("nitroai.apikey", "sk-user-key");
      localStorage.setItem("nitroai.prefs", JSON.stringify({ mode, onboarded: true, language: "English", publikDisclosureAck: 2 }));
      stubServer(
        { available: true, state: mode === "publik" ? "ready" : "unprovisioned", baseUrl: "/api/publik/v1", starterMicros: 0 },
        { balance_micros: 1_000_000, claim_state: "claimed" },
      );
      await renderSettings();
      await screen.findByRole("heading", { name: "AI Engine" });
      await waitFor(() => expect(intro()).toBe(text));
    });
  }
});
