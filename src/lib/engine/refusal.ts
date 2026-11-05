/* Provider refusal text that arrives as answer text.
 *
 * Some providers do not only stop with finish_reason "content_filter": they
 * also stream their moderation message as the last piece of the answer. On
 * 2026-11-05 (NitroAI 0.2.3 release smoke test) publik-balanced, served by
 * xiaomi/mimo-v2.6-pro through OpenRouter, ended a merge call this way, and
 * the note ended "…the streaming of the ascendingThe request was rejected
 * because it was considered high risk". That text must never reach a note,
 * a card, a quiz or a chat answer.
 *
 * Only exact provider messages are listed (not "I can't help with that"
 * phrases, which can be real content). A message counts only at the END of
 * the text (or as the whole text): that is where a provider puts it when it
 * stops the stream. */

export const PROVIDER_REFUSALS: readonly string[] = [
  // Xiaomi MiMo (publik-balanced on OpenRouter, seen 2026-11-05); Moonshot uses the same words.
  "The request was rejected because it was considered high risk",
  // Alibaba Qwen (DashScope "data_inspection_failed").
  "Input data may contain inappropriate content",
  "Output data may contain inappropriate content",
  // DeepSeek.
  "Content Exists Risk",
  // Zhipu GLM (code 1301), first sentence.
  "系统检测到输入或生成内容可能包含不安全或敏感内容",
];

/* Whitespace and closing punctuation a provider may put after its message. */
const TAIL = /[\s.。!！,，;；:："'”’)\]}]*$/u;

export interface RefusalCheck {
  /* The text with the refusal message taken off its end. */
  text: string;
  /* The refusal message that was found, or null. */
  refusal: string | null;
}

/* Take a provider refusal message off the end of `text`. The message is
   often glued to the last word ("ascendingThe request was …"), so it is
   matched as a substring at the end, not as a whole line. Zhipu's message
   goes on after its first sentence, so for it everything from the message to
   the end is taken off. */
export function stripRefusal(text: string): RefusalCheck {
  const body = text.replace(TAIL, "");
  const lower = body.toLowerCase();
  let cut = -1;
  let found: string | null = null;
  for (const message of PROVIDER_REFUSALS) {
    const m = message.toLowerCase();
    const at = lower.lastIndexOf(m);
    if (at < 0) continue;
    const rest = body.slice(at + m.length);
    // At the end, or (Zhipu) followed only by the rest of its own notice.
    const atEnd = rest.replace(TAIL, "") === "" || (/[一-鿿]/.test(message) && !/[A-Za-z]/.test(rest));
    if (atEnd && (cut < 0 || at < cut)) {
      cut = at;
      found = message;
    }
  }
  if (cut < 0) return { text, refusal: null };
  return { text: body.slice(0, cut).replace(/\s+$/, ""), refusal: found };
}
