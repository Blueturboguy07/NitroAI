// @vitest-environment jsdom
/* First run with publik API first (R21 §4.3, contract §3.2 [S4]; founder
   2026-11-02 "publik api should be front and center"): the first screen is
   the publik disclosure with ONE primary button, its Continue is what mints
   and (one press connects and links) opens the claim page; Local and the
   user's own key sit below in a section that starts closed; nothing ever
   lands in the user's key slot. Without a build token the page is exactly
   the two-card page it always was. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

function stubServer(
  status: Record<string, unknown>,
  onProvision?: (body: unknown) => Record<string, unknown>,
  wallet: () => Record<string, unknown> | null = () => null,
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "/api/publik/status") return json(status);
      if (url === "/api/publik/provision") {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        return json(onProvision ? onProvision(body) : { ok: true, minted: true, ...status, state: "ready" });
      }
      if (url === "/api/publik/wallet") {
        const w = wallet();
        return w ? json(w) : new Response("not found", { status: 404 });
      }
      if (url.startsWith("/api/local/status")) return json({ installed: false, serving: false, hasChatModel: false, hasEmbedModel: false, models: [] });
      return new Response("not found", { status: 404 });
    }),
  );
  return calls;
}

/* The buttons drawn as the primary action (filled accent). */
const primaryButtons = (root: HTMLElement = document.body) =>
  Array.from(root.querySelectorAll("button")).filter((b) => b.className.split(/\s+/).includes("bg-accent"));

async function renderOnboarding() {
  const { AppProvider } = await import("../lib/app");
  const { default: Onboarding } = await import("./Onboarding");
  render(
    <MemoryRouter initialEntries={["/onboarding"]}>
      <AppProvider>
        <Onboarding />
      </AppProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  // jsdom has no window.open; Continue opens the claim page on every mint.
  vi.stubGlobal("open", vi.fn());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const READY = { available: true, state: "ready", baseUrl: "/api/publik/v1", models: { fast: "publik-fast", balanced: "publik-balanced" } };
const WHY =
  "A provider charges for every request the app makes; publik pays that bill and passes it on at half the provider's list price. Nothing is charged behind your back — usage only draws from a plan or pack you choose to buy.";

describe("Onboarding — first-run card after the mint (contract §12)", () => {
  it("one press: Continue mints AND opens the reply's claim_url; the card shows the balance, the justification and 'Open the link page again'", async () => {
    // Migration 0059: a new, unlinked computer is minted at $0.00.
    const calls = stubServer({ available: true, state: "unprovisioned", baseUrl: "/api/publik/v1" }, () => ({
      ok: true,
      minted: true,
      ...READY,
      claimUrl: "https://publikhq.com/claim/HK7F-2QWD",
      starterMicros: 0,
      balanceMicros: 0,
    }));
    const open = vi.fn();
    vi.stubGlobal("open", open);
    await renderOnboarding();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Continue with publik API" }));

    // The one press already opened the claim page.
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("https://publikhq.com/claim/HK7F-2QWD", "_blank", "noopener");

    const card = await screen.findByTestId("publik-welcome-card");
    // (a) balance line from the response, (b) the one sentence, (c) the primary button — in that order.
    // A $0.00 unlinked balance says what linking gives — never "$0.00 of free use".
    expect(screen.getByTestId("publik-starter-line")).toHaveTextContent("$0.00 · link this computer for $0.05 of free use");
    expect(card.textContent).not.toMatch(/\$0\.00 of free|free starter/);
    expect(card).toHaveTextContent("At $0.00, publik API can't answer requests.");
    expect(card).toHaveTextContent(WHY);
    expect(screen.getByTestId("publik-link-opened")).toHaveTextContent('publikhq.com is open in your browser. Press "Link this computer" there.');
    const primary = screen.getByRole("button", { name: /^Open the link page again/ });
    expect(primaryButtons(card)).toEqual([primary]);
    expect(card.textContent!.indexOf("$0.00 · link this computer")).toBeLessThan(card.textContent!.indexOf("A provider charges"));
    expect(card.textContent!.indexOf("A provider charges")).toBeLessThan(card.textContent!.indexOf("Open the link page again"));
    // Copy rule (contract §1): dollars, never "credits", never "OpenAI API access".
    expect(card.textContent).not.toMatch(/\bcredits\b|OpenAI API access|ChatGPT credits/i);

    // Opening the page again does not leave the card: the app waits for the link (or "Later").
    await user.click(primary);
    expect(open).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem("nitroai.prefs")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Later" }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("nitroai.prefs") ?? "{}")).toMatchObject({ mode: "publik", onboarded: true }));
    expect(calls.filter((c) => c.url === "/api/publik/provision")).toHaveLength(1);
  });

  it("enters the app by itself once the wallet says this computer is linked", async () => {
    let linked = false;
    stubServer(
      { available: true, state: "unprovisioned", baseUrl: "/api/publik/v1" },
      () => ({ ok: true, minted: true, ...READY, claimUrl: "https://publikhq.com/claim/HK7F-2QWD", starterMicros: 0 }),
      () => ({ balance_micros: linked ? 50_000 : 0, claim_state: linked ? "claimed" : "anonymous" }),
    );
    vi.stubGlobal("open", vi.fn());
    await renderOnboarding();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Continue with publik API" }));
    await screen.findByTestId("publik-welcome-card");
    expect(localStorage.getItem("nitroai.prefs")).toBeNull();
    linked = true; // the person pressed "Link this computer" on publikhq.com
    await waitFor(
      () => expect(JSON.parse(localStorage.getItem("nitroai.prefs") ?? "{}")).toMatchObject({ mode: "publik", onboarded: true, publikDisclosureAck: 2 }),
      { timeout: 8000 },
    );
  }, 15_000);

  it("a starter above $0.00 (a mint bound to an account) renders whatever amount the server sent — never a fixed figure", async () => {
    stubServer({ available: true, state: "unprovisioned", baseUrl: "/api/publik/v1" }, () => ({
      ok: true,
      minted: true,
      ...READY,
      claimUrl: "https://publikhq.com/claim/AAAA-BBBB",
      starterMicros: 1_000_000,
    }));
    await renderOnboarding();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Continue with publik API" }));
    expect(await screen.findByTestId("publik-starter-line")).toHaveTextContent("$1.00 of free use");
    expect(screen.getByTestId("publik-welcome-card")).toHaveTextContent("Pick a plan any time in Settings.");
  });

  it("a claim_url off publikhq.com is dropped: no primary button, 'Later' still works", async () => {
    stubServer({ available: true, state: "unprovisioned", baseUrl: "/api/publik/v1" }, () => ({
      ok: true,
      minted: true,
      ...READY,
      claimUrl: "https://evil.example/claim/HK7F-2QWD",
      starterMicros: 0,
    }));
    const open = vi.fn();
    vi.stubGlobal("open", open);
    await renderOnboarding();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Continue with publik API" }));
    await screen.findByTestId("publik-welcome-card");
    // No link to offer, so the $0.00 line promises nothing about linking.
    expect(screen.getByTestId("publik-starter-line")).toHaveTextContent("Your balance starts at $0.00.");
    expect(screen.queryByRole("button", { name: /Link this computer & pick a plan/ })).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("evil.example");
    await user.click(screen.getByRole("button", { name: "Later" }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("nitroai.prefs") ?? "{}")).toMatchObject({ mode: "publik", onboarded: true }));
    expect(open).not.toHaveBeenCalled();
  });

  it("'Later' changes nothing: the credential stays, the user's own key is untouched, nothing is forgotten or re-minted", async () => {
    localStorage.setItem("nitroai.apikey", "sk-user-key-untouched");
    const calls = stubServer({ available: true, state: "unprovisioned", baseUrl: "/api/publik/v1" }, () => ({
      ok: true,
      minted: true,
      ...READY,
      claimUrl: "https://publikhq.com/claim/HK7F-2QWD",
      starterMicros: 0,
    }));
    const open = vi.fn();
    vi.stubGlobal("open", open);
    await renderOnboarding();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Continue with publik API" }));
    await user.click(await screen.findByRole("button", { name: "Later" }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("nitroai.prefs") ?? "{}")).toMatchObject({ mode: "publik", onboarded: true, publikDisclosureAck: 2 }));
    // Only the one press opened the claim page; "Later" opens nothing.
    expect(open).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("nitroai.apikey")).toBe("sk-user-key-untouched");
    const urls = calls.map((c) => c.url);
    expect(urls).not.toContain("/api/publik/forget");
    expect(urls).not.toContain("/api/publik/disconnect");
    expect(urls.filter((u) => u === "/api/publik/provision")).toHaveLength(1);
  });
});

describe("Onboarding — publik API default", () => {
  it("the first screen is the publik disclosure with ONE primary button; Local and own key sit below, closed", async () => {
    const calls = stubServer({ available: true, state: "unprovisioned", baseUrl: "/api/publik/v1", disclosureVersion: 2 });
    vi.stubGlobal("open", vi.fn());
    await renderOnboarding();
    const user = userEvent.setup();

    expect(await screen.findByRole("heading", { name: "NitroAI uses publik API" })).toBeInTheDocument();
    const cont = screen.getByRole("button", { name: "Continue with publik API" });
    expect(primaryButtons()).toEqual([cont]);
    expect(screen.getByText(/priced per use at 50% of the model's published list price/)).toBeInTheDocument();
    expect(screen.getByText(/never trains on them/)).toBeInTheDocument();
    // Own key and Local are below, closed: no key field, no cards, no second button next to Continue.
    const others = screen.getByRole("button", { name: "Other ways to run NitroAI: your own key, or fully local" });
    expect(others).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Use my own key instead" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Fully local/ })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("sk-... or sk-ant-...")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Get started" })).not.toBeInTheDocument();
    // publik leads the page: the disclosure comes before the closed section.
    expect(document.body.textContent!.indexOf("NitroAI uses publik API")).toBeLessThan(document.body.textContent!.indexOf("Other ways to run NitroAI"));
    // No mint before consent.
    expect(calls.filter((c) => c.url === "/api/publik/provision")).toHaveLength(0);

    await user.click(cont);

    // Contract §12.1/12.4: the mint is followed by the first-run card, never
    // by a silent entry into the app.
    await screen.findByTestId("publik-welcome-card");
    expect(localStorage.getItem("nitroai.prefs")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Later" }));

    await waitFor(() => {
      const prefs = JSON.parse(localStorage.getItem("nitroai.prefs") ?? "{}");
      expect(prefs).toMatchObject({ mode: "publik", onboarded: true, publikDisclosureAck: 2 });
    });
    const mint = calls.filter((c) => c.url === "/api/publik/provision");
    expect(mint).toHaveLength(1);
    expect(JSON.parse(mint[0].init?.body as string)).toMatchObject({ disclosure_version: 2, force: false });
    expect(localStorage.getItem("nitroai.apikey")).toBeNull();
  });

  it("'Other ways to run NitroAI' opens the own-key field; a key there skips the mint entirely", async () => {
    const calls = stubServer({ available: true, state: "unprovisioned", baseUrl: "/api/publik/v1" });
    await renderOnboarding();
    const user = userEvent.setup();
    await screen.findByRole("button", { name: "Continue with publik API" });
    await user.click(screen.getByRole("button", { name: "Other ways to run NitroAI: your own key, or fully local" }));
    expect(screen.getByRole("button", { name: /Fully local/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Use my own key Use your OpenAI/ }));
    const input = await screen.findByPlaceholderText("sk-... or sk-ant-...");
    await user.type(input, "sk-my-own");
    await user.click(screen.getByRole("button", { name: "Get started" }));
    await waitFor(() => expect(localStorage.getItem("nitroai.apikey")).toBe("sk-my-own"));
    expect(JSON.parse(localStorage.getItem("nitroai.prefs")!)).toMatchObject({ mode: "cloud", onboarded: true });
    expect(calls.filter((c) => c.url === "/api/publik/provision")).toHaveLength(0);
  });

  it("a failed mint keeps the user on the page with an explanation and no prefs written", async () => {
    stubServer({ available: true, state: "unprovisioned", baseUrl: "/api/publik/v1" }, () => ({
      ok: false,
      minted: false,
      reason: "gateway_unavailable",
      available: true,
      state: "unprovisioned",
      baseUrl: "/api/publik/v1",
    }));
    await renderOnboarding();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Continue with publik API" }));
    expect(await screen.findByText(/publik API is unreachable right now/)).toBeInTheDocument();
    expect(localStorage.getItem("nitroai.prefs")).toBeNull();
  });

  it("without a build token the page is the two-card page: no publik card, no publik copy, no default", async () => {
    stubServer({ available: false, state: "unprovisioned", baseUrl: "/api/publik/v1" });
    await renderOnboarding();
    await screen.findByRole("button", { name: /Fully local/ });
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /Recommended/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Bring your own key/ })).toBeInTheDocument();
    expect(screen.queryByText(/publik/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Get started" })).toBeDisabled();
  });
});
