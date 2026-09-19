/* Every publik-facing string in one place (R21 §4 copy, contract §1 copy
   rule). Rules: the provider is always "publik API"; dollars, never tokens,
   never a made-up unit; the rate is stated, never an hourly figure; the
   starter amount is rendered from the server, never hardcoded. */

/* Bump together with server/publik.mjs DISCLOSURE_VERSION when this changes. */
export const DISCLOSURE_VERSION = 2;

export const PUBLIK_TERMS_URL = "https://publikhq.com/terms#api";
export const PUBLIK_PRICING_URL = "https://publikhq.com/developers#plans";

export const disclosure = {
  title: "NitroAI uses publik API",
  intro:
    "NitroAI needs an AI model to work. By default it runs on publik API, so you can start right away without an account or a key.",
  costHeading: "Cost.",
  cost:
    "Every request is priced per use at 50% of the model's published list price, from your publik balance. A small free starter balance is added when you continue. Most people spend under $2 a month. You can see every charge in the app and at publikhq.com.",
  dataHeading: "Where your prompts go.",
  data:
    "Your prompts go through publik's servers to a shared model account. publik does not keep your prompts after the reply and never trains on them; the model provider may retain them briefly for abuse monitoring. You can switch to your own key at any time in Settings.",
  continueLabel: "Continue with publik API",
  ownKeyLabel: "Use my own key instead",
  termsPrefix: "By continuing you agree to the",
  termsLink: "publik API terms",
};

export const onboardingCard = {
  title: "publik API",
  badge: "Recommended",
  body:
    "Notes, flashcards, quizzes and chat run on publik's metered API — pay only for what you use, priced per use at 50% of the model's published list price. Most people spend under $2 a month. No account or key needed.",
};

export const settings = {
  rate: "Every request is priced per use at 50% of the model's published list price. Most people spend under $2 a month.",
  atCost: "Audio transcription, podcast voices and embeddings are passed through at cost.",
  data: "Your prompts go through publik's servers to a shared model account. publik does not keep your prompts after the reply and never trains on them.",
  linkLabel: "Link this computer to your publik account",
  addCreditLabel: "Add credit",
  pricingLabel: "How pricing works",
  ownKeyLabel: "Use my own key instead",
  disconnectLabel: "Disconnect publik API",
  forgetLabel: "Forget publik on this computer",
  reconnectLabel: "Reconnect",
  retryLabel: "Retry",
  exhaustedAnonymous:
    "publik API needs credit. Your free starter balance is used up. Link this computer to your publik account to add credit, or use your own key.",
  exhaustedClaimed: "publik API needs credit.",
  disconnected: "publik API is disconnected. This computer was removed from your publik account.",
  unreachable: "publik API is unreachable right now. Nothing is being charged. Try again in a minute, or use your own key.",
  notSetUp: "publik API isn't set up on this computer yet.",
};
