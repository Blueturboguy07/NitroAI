// Supplementary verification probe — NOT used by oracle.sh, which only
// exercises tier "fast" (via .complete() with no `tier` in opts). The
// "strong" tier fallback (same resolveModel() line) is reachable from real
// usage via src/lib/generation/index.ts (7 call sites pass tier: "strong"),
// so it needs its own live check.
import { AnthropicEngine } from './src/lib/engine/anthropic.ts';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) { console.error('NO_KEY'); process.exit(2); }

// No modelOverride passed -> resolveModel("strong") falls through to the
// hardcoded strong-tier default exactly as a real generation call would use it.
const engine = new AnthropicEngine(apiKey);

try {
  const out = await engine.complete({
    system: 'You are a test.',
    messages: [{ role: 'user', content: 'Say hi in one word.' }],
    tier: 'strong',
  });
  console.log('SUCCESS (strong tier), reply:', out);
  process.exit(0);
} catch (err: any) {
  console.log('APP_ERROR_MESSAGE (strong tier):', err.message, 'kind:', err.kind);
  process.exit(1);
}
