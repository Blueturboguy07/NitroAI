import { describe, expect, it } from "vitest";
import { detectProvider, PUBLIK_KEY_FORMAT, resolveProvider } from "./keys";

const PK = "pk_live_a8k2m9x4q7v1_h3n6r9t2w5y8z1b4c7d0f3g6j9k2m5p8";

describe("detectProvider", () => {
  it("recognises the exact publik key format (live and test)", () => {
    expect(detectProvider(PK)).toBe("publik");
    expect(detectProvider(PK.replace("pk_live_", "pk_test_"))).toBe("publik");
    expect(PUBLIK_KEY_FORMAT.test(PK)).toBe(true);
  });

  it("rejects pk_ strings with the wrong shape", () => {
    expect(detectProvider("pk_live_short_key")).toBeNull();
    expect(detectProvider("pk_live_a8k2m9x4q7v1_h3n6r9t2w5y8z1b4c7d0f3g6j9k2m5p")).toBeNull(); // 31 chars
    expect(detectProvider("pk_prod_a8k2m9x4q7v1_h3n6r9t2w5y8z1b4c7d0f3g6j9k2m5p8")).toBeNull();
    expect(detectProvider("PK_LIVE_A8K2M9X4Q7V1_H3N6R9T2W5Y8Z1B4C7D0F3G6J9K2M5P8")).toBeNull();
  });

  it("keeps the BYO prefixes and trims whitespace", () => {
    expect(detectProvider("sk-ant-abc")).toBe("anthropic");
    expect(detectProvider("sk-abc")).toBe("openai");
    expect(detectProvider(`  ${PK}\n`)).toBe("publik");
    expect(detectProvider("  sk-abc ")).toBe("openai");
    expect(detectProvider("")).toBeNull();
    expect(detectProvider("hello")).toBeNull();
  });

  it("recognises Google AI Studio (Gemini) keys", () => {
    const key = "AIzaSyD3x4mPl3K3y-abcdefghijklmnopq_rst";
    expect(detectProvider(key)).toBe("gemini");
    expect(detectProvider(` ${key}\n`)).toBe("gemini");
    expect(detectProvider("AIza")).toBeNull();
    // AI Studio's newer auth keys.
    expect(detectProvider("AQ.Ab8RN6IJk_2mXyz-0123456789abcdefgh")).toBe("gemini");
    expect(detectProvider("AQ.short")).toBeNull();
  });
});

describe("resolveProvider", () => {
  it("prefers the provider picked in Settings, else detects", () => {
    expect(resolveProvider("sk-abc", "")).toBe("openai");
    expect(resolveProvider("some-new-key-format", "gemini")).toBe("gemini");
    expect(resolveProvider("", "gemini")).toBeNull();
    expect(resolveProvider("some-new-key-format")).toBeNull();
  });
});
