// @vitest-environment jsdom
/* Contract §12.3 / task item 3: a 402, or a starter below 20%, becomes a
   non-blocking banner with the message and exactly one link (top_up_url /
   claim_url). Off-publikhq.com links are dropped. Only shown while the
   active engine is publik — BYO and local never see it. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const WHY =
  "A provider charges for every request the app makes; publik pays that bill and passes it on at half the provider's list price. Nothing is charged behind your back — usage only draws from a plan or pack you choose to buy.";

function stubServer(status: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/publik/status") return json(status);
      if (url === "/api/publik/wallet") return json({ balance_micros: 250_000, claim_state: "anonymous" });
      return new Response("not found", { status: 404 });
    }),
  );
}

async function renderBanner() {
  const { AppProvider } = await import("../lib/app");
  const { default: PublikBanner } = await import("./PublikBanner");
  render(
    <MemoryRouter>
      <AppProvider>
        <PublikBanner />
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

describe("bannerFor()", () => {
  it("a 402 notice wins, carries the server message and only top_up_url; foreign links are dropped", async () => {
    const { bannerFor } = await import("./PublikBanner");
    const msg = "Not enough publik credit for this request. Link this computer and pick a plan at the link below, or use your own key.";
    expect(bannerFor({ creditNotice: { message: msg, url: "https://publikhq.com/claim/X", claimState: "anonymous", at: 1 } })).toEqual({
      key: "credit:1",
      message: msg,
      url: "https://publikhq.com/claim/X",
      label: "Link this computer & pick a plan",
    });
    expect(bannerFor({ creditNotice: { message: msg, url: "https://publikhq.com/dashboard/api/add", claimState: "claimed", at: 2 } })?.label).toBe("Manage plan");
    expect(bannerFor({ creditNotice: { message: msg, url: "https://evil.example/pay", at: 3 } })).toBeNull();
    expect(bannerFor({})).toBeNull();
  });

  it("starter below 20% (both numbers from the server) → computed line + claim_url + the justification; not once claimed, not without a link", async () => {
    const { bannerFor } = await import("./PublikBanner");
    const low = bannerFor({ starterMicros: 250_000, starterRemainingMicros: 40_000, claimUrl: "https://publikhq.com/claim/X" });
    expect(low).toMatchObject({ key: "low-starter", url: "https://publikhq.com/claim/X", label: "Link this computer & pick a plan" });
    expect(low!.message).toBe(`$0.04 of your $0.25 free starter usage is left. Link this computer and pick a plan to keep going. ${WHY}`);
    expect(bannerFor({ starterMicros: 250_000, starterRemainingMicros: 60_000, claimUrl: "https://publikhq.com/claim/X" })).toBeNull();
    expect(bannerFor({ starterMicros: 250_000, starterRemainingMicros: 40_000, claimUrl: "https://publikhq.com/claim/X", claimState: "claimed" })).toBeNull();
    expect(bannerFor({ starterMicros: 250_000, starterRemainingMicros: 40_000 })).toBeNull();
    expect(bannerFor({ starterMicros: 250_000, starterRemainingMicros: 40_000, claimUrl: "https://evil.example/claim" })).toBeNull();
  });
});

describe("<PublikBanner />", () => {
  it("a 402 reported through describeError() shows the server message with one link; Dismiss hides it", async () => {
    localStorage.setItem("nitroai.prefs", JSON.stringify({ mode: "publik", onboarded: true, language: "English", publikDisclosureAck: 2 }));
    stubServer({ available: true, state: "ready", baseUrl: "/api/publik/v1", claimUrl: "https://publikhq.com/claim/HK7F-2QWD", starterMicros: 250_000 });
    const open = vi.fn();
    vi.stubGlobal("open", open);
    await renderBanner();
    const { describeError, getBalance } = await import("../lib/publik");
    const { EngineError } = await import("../lib/engine/types");
    await waitFor(() => expect(getBalance().starterMicros).toBe(250_000));
    expect(screen.queryByTestId("publik-banner")).not.toBeInTheDocument();

    const msg = "Not enough publik credit for this request. Link this computer and pick a plan at the link below, or use your own key.";
    act(() => {
      describeError(new EngineError(msg, "credit", { topUpUrl: "https://publikhq.com/claim/HK7F-2QWD", claimState: "anonymous" }));
    });
    const banner = await screen.findByTestId("publik-banner");
    expect(banner).toHaveTextContent(msg);
    const links = banner.querySelectorAll("button:not([aria-label])");
    expect(links).toHaveLength(1);
    const user = userEvent.setup();
    await user.click(links[0] as HTMLElement);
    expect(open).toHaveBeenCalledWith("https://publikhq.com/claim/HK7F-2QWD", "_blank", "noopener");
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("publik-banner")).not.toBeInTheDocument();
  });

  it("a starter below 20% shows the low-starter line with the claim link; a later usage header above 20% clears it", async () => {
    localStorage.setItem("nitroai.prefs", JSON.stringify({ mode: "publik", onboarded: true, language: "English", publikDisclosureAck: 2 }));
    stubServer({ available: true, state: "ready", baseUrl: "/api/publik/v1", claimUrl: "https://publikhq.com/claim/HK7F-2QWD", starterMicros: 250_000 });
    await renderBanner();
    const { getBalance, usageToBalance } = await import("../lib/publik");
    await waitFor(() => expect(getBalance().starterMicros).toBe(250_000));
    act(() => usageToBalance({ balanceMicros: 30_000, starterRemainingMicros: 30_000, claimState: "anonymous", streamed: false }));
    const banner = await screen.findByTestId("publik-banner");
    expect(banner).toHaveTextContent("$0.03 of your $0.25 free starter usage is left.");
    expect(banner.querySelectorAll("button:not([aria-label])")).toHaveLength(1);
    expect(banner.textContent).not.toMatch(/\bcredits\b|OpenAI API access/i);
    act(() => usageToBalance({ balanceMicros: 200_000, starterRemainingMicros: 200_000, claimState: "anonymous", streamed: false }));
    await waitFor(() => expect(screen.queryByTestId("publik-banner")).not.toBeInTheDocument());
  });

  it("never renders for a BYO or local engine, even with a notice in the store", async () => {
    localStorage.setItem("nitroai.apikey", "sk-user-key");
    localStorage.setItem("nitroai.prefs", JSON.stringify({ mode: "cloud", onboarded: true, language: "English" }));
    stubServer({ available: true, state: "ready", baseUrl: "/api/publik/v1", claimUrl: "https://publikhq.com/claim/X", starterMicros: 250_000 });
    await renderBanner();
    const { setBalance } = await import("../lib/publik");
    act(() => setBalance({ creditNotice: { message: "m", url: "https://publikhq.com/claim/X", at: 1 }, starterMicros: 250_000, starterRemainingMicros: 0, claimUrl: "https://publikhq.com/claim/X" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("publik-banner")).not.toBeInTheDocument();
  });
});
