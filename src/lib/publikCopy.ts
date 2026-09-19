/* Every publik-facing string in one place (R21 §4 copy, contract §1 copy
   rule). Rules: the provider is always "publik API"; dollars, never tokens,
   never a made-up unit; the rate is stated, never an hourly figure; the
   starter amount is rendered from the server, never hardcoded. */

/* Bump together with server/publik.mjs DISCLOSURE_VERSION when this changes. */
export const DISCLOSURE_VERSION = 2;

export const PUBLIK_TERMS_URL = "https://publikhq.com/terms#api";
export const PUBLIK_PRICING_URL = "https://publikhq.com/developers#plans";
export const PUBLIK_DASHBOARD_URL = "https://publikhq.com/dashboard/api";

/* The ONE justification for charging (contract §12; the site's
   lib/publik-api/why-it-costs.ts holds the same argument). Every surface that
   mentions money — the first-run card, the settings card, the low-balance
   banner — renders this sentence and nothing invented. */
export const whyItCosts =
  "A provider charges for every request the app makes; publik pays that bill and passes it on at half the provider's list price. Nothing is charged behind your back — usage only draws from a plan or pack you choose to buy.";

/* The plan CTA (contract §12.1–12.2). The starter amount is always rendered
   from the server's reply; `starterLine` only shapes it. */
export const cta = {
  cardTitle: "publik API is set up on this computer",
  /* "<amount> of free starter usage" — `amount` is rendered from starter_micros. */
  starterLine: (amount: string) => `${amount} of free starter usage`,
  starterUnknown: "Free starter usage is ready on this computer",
  linkLabel: "Link this computer & pick a plan",
  laterLabel: "Later",
  laterHint: "You keep the free starter either way. Pick a plan any time in Settings.",
  pickPlanLabel: "Pick a plan",
  managePlanLabel: "Manage plan",
  whyLabel: "Why it costs money",
  /* Low starter banner: "<left> of your <total> free starter usage is left." */
  lowStarter: (left: string, total: string) => `${left} of your ${total} free starter usage is left. Link this computer and pick a plan to keep going.`,
  lowStarterLink: "Link this computer & pick a plan",
  dismissLabel: "Dismiss",
};

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
  addPlanLabel: "Add a plan or pack",
  pricingLabel: "How pricing works",
  ownKeyLabel: "Use my own key instead",
  disconnectLabel: "Disconnect publik API",
  forgetLabel: "Forget publik on this computer",
  reconnectLabel: "Reconnect",
  retryLabel: "Retry",
  exhaustedAnonymous:
    "publik API needs a plan. Your free starter usage is used up. Link this computer and pick a plan, or use your own key.",
  exhaustedClaimed: "publik API needs a plan or pack.",
  disconnected: "publik API is disconnected. This computer was removed from your publik account.",
  unreachable: "publik API is unreachable right now. Nothing is being charged. Try again in a minute, or use your own key.",
  notSetUp: "publik API isn't set up on this computer yet.",
};
