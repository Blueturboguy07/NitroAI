/* Every publik-facing string in one place (R21 §4 copy, contract §1 copy
   rule). Rules: the provider is always "publik API"; dollars, never tokens,
   never a made-up unit; the rate is stated, never an hourly figure; a
   starter amount the mint reply carries is rendered from the server, never
   hardcoded. The link grant (LINK_FREE_USE) is the one starter amount
   written here. */

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

/* publik API policy (founder, 2026-09-28; platform migration 0059): a new
   computer starts at $0.00. The one free thing is $0.05 of use, paid once per
   publik account when a computer is first linked to it. An unlinked install's
   mint reply carries starter_micros 0, so no reply can tell it this amount;
   this is the only place it is written. Every metered call answers 402 until
   the computer is linked, a plan or pack is bought, or the user's own key is
   in use. */
export const LINK_FREE_USE = "$0.05";

/* The plan CTA (contract §12.1–12.2). A starter amount from the mint reply is
   always rendered from the server; `starterLine` only shapes it. */
export const cta = {
  cardTitle: "publik API is set up on this computer",
  /* "<amount> of free use" — `amount` is rendered from a starter_micros above 0
     (a mint already bound to a publik account, or an install minted before
     migration 0059). */
  starterLine: (amount: string) => `${amount} of free use`,
  /* The balance line of an unlinked computer at $0.00. */
  zeroStarterLine: `$0.00 · link this computer for ${LINK_FREE_USE} of free use`,
  /* $0.00 with no claim link to offer. */
  zeroBalanceLine: "Your balance starts at $0.00.",
  /* The mint reply carried no amount at all. */
  starterUnknown: `Linking your publik account gives ${LINK_FREE_USE} of free use, once.`,
  linkLabel: "Link this computer & pick a plan",
  laterLabel: "Later",
  laterHint: "Pick a plan any time in Settings.",
  /* Under "Later" while this computer is unlinked at $0.00. */
  laterHintUnlinked:
    "At $0.00, publik API can't answer requests. Link this computer, add a plan or pack, or use your own key. You can do this any time in Settings.",
  pickPlanLabel: "Pick a plan",
  managePlanLabel: "Manage plan",
  whyLabel: "Why it costs money",
  /* Low starter banner: "<left> of your <total> free use is left." Only an
     install minted before migration 0059 still has an unlinked starter; a new
     one starts at $0.00, so starterIsLow() never fires for it. */
  lowStarter: (left: string, total: string) => `${left} of your ${total} free use is left. Link this computer and pick a plan to keep going.`,
  lowStarterLink: "Link this computer & pick a plan",
  dismissLabel: "Dismiss",
};

export const disclosure = {
  title: "NitroAI uses publik API",
  intro:
    "NitroAI needs an AI model to work. By default it runs on publik API, so you don't need a key of your own.",
  costHeading: "Cost.",
  cost:
    `Every request is priced per use at 50% of the model's published list price, from your publik balance. A new computer starts at $0.00 and no card is asked for: linking this computer to your publik account gives ${LINK_FREE_USE} of free use, once, and a plan, a pack or your own key takes it from there. Most people spend under $2 a month. You can see every charge in the app and at publikhq.com.`,
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
    `Notes, flashcards, quizzes and chat run on publik's metered API — pay only for what you use, priced per use at 50% of the model's published list price. Most people spend under $2 a month. No key needed: link your publik account for ${LINK_FREE_USE} of free use, once.`,
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
    `publik API has no balance on this computer. Link this computer to your publik account (${LINK_FREE_USE} of free use, once), pick a plan, or use your own key.`,
  exhaustedClaimed: "publik API needs a plan or pack.",
  disconnected: "publik API is disconnected. This computer was removed from your publik account.",
  unreachable: "publik API is unreachable right now. Nothing is being charged. Try again in a minute, or use your own key.",
  notSetUp: "publik API isn't set up on this computer yet.",
};
