// @vitest-environment jsdom
/* First run with publik API as the default (R21 §4.3, contract §3.2 [S4]):
   the publik card is preselected, the disclosure is the last step, its
   Continue is what mints, and nothing ever lands in the user's key slot.
   Without a build token the page is exactly the two-card page it always was. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

function stubServer(status: Record<string, unknown>, onProvision?: (body: unknown) => Record<string, unknown>) {
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
      if (url.startsWith("/api/local/status")) return json({ installed: false, serving: false, hasChatModel: false, hasEmbedModel: false, models: [] });
      return new Response("not found", { status: 404 });
    }),
  );
  return calls;
}

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
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Onboarding — publik API default", () => {
  it("offers three cards with publik preselected and the disclosure; Continue mints and writes prefs, never the key slot", async () => {
    const calls = stubServer({ available: true, state: "unprovisioned", baseUrl: "/api/publik/v1", disclosureVersion: 2 });
    await renderOnboarding();
    const user = userEvent.setup();

    expect(await screen.findByRole("button", { name: /Recommended/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Fully local/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Use my own key Use your OpenAI/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "NitroAI uses publik API" })).toBeInTheDocument();
    // The rate sentence is on the card AND in the disclosure; the sheet adds the data-path sentence.
    expect(screen.getAllByText(/priced per use at 50% of the model's published list price/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/Most people spend under \$2 a month/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/never trains on them/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Get started" })).not.toBeInTheDocument();
    // No mint before consent.
    expect(calls.filter((c) => c.url === "/api/publik/provision")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Continue with publik API" }));

    await waitFor(() => {
      const prefs = JSON.parse(localStorage.getItem("nitroai.prefs") ?? "{}");
      expect(prefs).toMatchObject({ mode: "publik", onboarded: true, publikDisclosureAck: 2 });
    });
    const mint = calls.filter((c) => c.url === "/api/publik/provision");
    expect(mint).toHaveLength(1);
    expect(JSON.parse(mint[0].init?.body as string)).toMatchObject({ disclosure_version: 2, force: false });
    expect(localStorage.getItem("nitroai.apikey")).toBeNull();
  });

  it("'Use my own key instead' reveals the key field and skips the mint entirely", async () => {
    const calls = stubServer({ available: true, state: "unprovisioned", baseUrl: "/api/publik/v1" });
    await renderOnboarding();
    const user = userEvent.setup();
    await screen.findByRole("button", { name: "Continue with publik API" });
    await user.click(screen.getByRole("button", { name: "Use my own key instead" }));
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
