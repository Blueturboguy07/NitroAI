import { AnthropicEngine } from './src/lib/engine/anthropic.ts';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) { console.error('NO_KEY'); process.exit(2); }

// No modelOverride passed -> resolveModel() falls through to the hardcoded
// default exactly as a fresh NitroAI install would use it.
const engine = new AnthropicEngine(apiKey);

try {
  const out = await engine.complete({
    system: 'You are a test.',
    messages: [{ role: 'user', content: 'Say hi in one word.' }],
  });
  console.log('SUCCESS, reply:', out);
  process.exit(0);
} catch (err: any) {
  console.log('APP_ERROR_MESSAGE:', err.message, 'kind:', err.kind);
  process.exit(1);
}
