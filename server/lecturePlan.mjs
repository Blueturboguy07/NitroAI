/* The cut planner for "Trim the solve-time gaps" (lecture.mjs runs it).
 *
 * A class video has long stretches where the teacher says "take a few
 * minutes on this" and nobody teaches. This file decides which stretches to
 * cut. It is PURE: no file, no process, no clock, no import. It gets numbers
 * and text and returns numbers.
 *
 * Two signals, used together:
 *   (a) silence: the intervals `ffmpeg -af silencedetect` printed;
 *   (b) the transcript: caption segments with times. A long stretch with no
 *       speech segment is a gap even when the room is noisy, and a teacher
 *       phrase such as "take a few minutes" just before it says why.
 *
 * Rules (planCuts):
 *   - With a transcript, a gap is a stretch with no speech segment. Speech
 *     is never cut, even when it is quiet. A gap of at least minGapSeconds is
 *     cut when ONE of these holds: a solve-break phrase comes just before
 *     it; silence covers at least half of it; or it is at least twice
 *     minGapSeconds long (a noisy room). The last reason alone never cuts
 *     the start or the end of the video, and is dropped when it would
 *     remove more than half of the video (captions that stop early).
 *   - With no transcript, a run of silence of at least minGapSeconds is cut.
 *     Noise shorter than 1 second inside a run (a cough, a chair) does not
 *     split it.
 *   - Each cut keeps padSeconds of the gap on both sides, so speech is not
 *     clipped.
 */

export const PLAN_DEFAULTS = { minGapSeconds: 30, padSeconds: 1.5 };
/* What the server accepts for the two options. */
export const PLAN_LIMITS = { minGapSeconds: [5, 600], padSeconds: [0, 10] };

/* A phrase within this many seconds before a gap explains the gap. */
const PHRASE_WINDOW_SECONDS = 20;
/* Noise this short does not split a run of silence (no transcript). */
const BRIDGE_SECONDS = 1;
/* A cut shorter than this after the padding is not worth a jump. */
const MIN_CUT_SECONDS = 1;
/* Part of a gap that silence must cover to count as a silent gap. */
const SILENT_SHARE = 0.5;
/* Cuts that only the transcript supports may remove at most this share. */
const TRANSCRIPT_ONLY_MAX_SHARE = 0.5;
const EPS = 1e-6;

const AMOUNT = "(?:a|an|one|two|three|four|five|six|seven|eight|ten|fifteen|twenty|thirty|a few|a couple(?: of)?|some|several|\\d+)";
const UNIT = "(?:minutes?|mins?|seconds?|secs?|moments?)";
const THING = "(?:this|that|it|these|those|the (?:next |first |last )?(?:problem|question|example|exercise)s?|problems?|questions?|number|part)";

/* Teacher phrases that start a solve break. Tested on lower-case text with
   single spaces. */
export const BREAK_PHRASES = [
  new RegExp(`\\btake (?:about |around |like )?${AMOUNT} (?:more |quick |short )?${UNIT}\\b`),
  new RegExp(`\\b(?:i will|i'll|i'm going to|i am going to|i'm gonna|let me|i'd like to|i want to) give you (?:all |guys )?(?:about |around |like )?(?:${AMOUNT} )?(?:more |quick |short )?(?:${UNIT}|time)\\b`),
  new RegExp(`\\byou(?: have| get|'ve got| have got)? (?:about |around )?${AMOUNT} ${UNIT} (?:to|for)\\b`),
  new RegExp(`\\b(?:work|working) (?:on|through) ${THING}\\b`),
  new RegExp(`\\btry ${THING}(?: one| out)? (?:on your own|yourself|yourselves|by yourself|first)\\b`),
  /\bon your own\b/,
  /\bpause the (?:video|recording|lecture)\b/,
  /\bgive (?:it|this|that|these) a (?:try|shot|go)\b/,
  /\b(?:work|talk|discuss|check) (?:it |this |that )?(?:over )?with (?:your|a|the person|the people) /,
  /\bgo ahead and (?:try|solve|work|do|attempt)\b/,
  /\btake (?:some|your|a little|a bit of) time\b/,
  /\bi(?:'ll| will) (?:wait|come back|be back|give you time)\b/,
];

export function hasBreakPhrase(text) {
  const t = String(text ?? "").toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ");
  return BREAK_PHRASES.some((re) => re.test(t));
}

/* Caption text that is speech: it has a letter or a digit outside
   "[Music]", "(silence)" and the like. */
function isSpeech(text) {
  if (typeof text !== "string") return true;
  return /[\p{L}\p{N}]/u.test(text.replace(/\[[^\]]*\]|\([^)]*\)|[♪♫]/g, " "));
}

/* Sorted, clamped to [0, duration], merged when they touch or are at most
   `bridge` seconds apart. Entries that are not numbers, or are empty, go. */
function tidy(intervals, duration, bridge = 0) {
  const list = [];
  for (const it of Array.isArray(intervals) ? intervals : []) {
    const start = Math.max(0, Number(it?.start));
    const end = Math.min(duration, Number(it?.end));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start <= EPS) continue;
    list.push({ start, end });
  }
  list.sort((a, b) => a.start - b.start);
  const out = [];
  for (const it of list) {
    const last = out[out.length - 1];
    if (last && it.start - last.end <= bridge + EPS) last.end = Math.max(last.end, it.end);
    else out.push({ ...it });
  }
  return out;
}

/* The parts of [0, duration] that `intervals` (tidy) do not cover. */
function complement(intervals, duration) {
  const out = [];
  let at = 0;
  for (const it of intervals) {
    if (it.start - at > EPS) out.push({ start: at, end: it.start });
    at = Math.max(at, it.end);
  }
  if (duration - at > EPS) out.push({ start: at, end: duration });
  return out;
}

function overlap(intervals, a) {
  let sum = 0;
  for (const it of intervals) sum += Math.max(0, Math.min(it.end, a.end) - Math.max(it.start, a.start));
  return sum;
}

function maxEnd(list) {
  let max = 0;
  for (const it of Array.isArray(list) ? list : []) {
    const end = Number(it?.end);
    if (Number.isFinite(end) && end > max) max = end;
  }
  return max;
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

/* The plan.
 *   silences: [{ start, end }] in seconds, in any order, may overlap.
 *   segments: [{ start, end, text }] transcript segments, the same.
 *   options:  { durationSeconds, minGapSeconds, padSeconds }. Without
 *             durationSeconds the video ends at the last interval's end.
 * Returns {
 *   keep:    [{ start, end }]            what stays, in order;
 *   cuts:    [{ start, end, reason }]    reason: "phrase" | "silence" | "transcript";
 *   summary: { originalSeconds, trimmedSeconds, removedSeconds, cuts },
 *   usedTranscript: boolean }. */
export function planCuts({ silences = [], segments = [], durationSeconds, minGapSeconds, padSeconds } = {}) {
  const minGap = Number.isFinite(minGapSeconds) && minGapSeconds > 0 ? minGapSeconds : PLAN_DEFAULTS.minGapSeconds;
  const pad = Number.isFinite(padSeconds) && padSeconds >= 0 ? padSeconds : PLAN_DEFAULTS.padSeconds;
  const given = Number(durationSeconds);
  const duration = Number.isFinite(given) && given > 0 ? given : Math.max(maxEnd(silences), maxEnd(segments));

  const spoken = (Array.isArray(segments) ? segments : []).filter((s) => isSpeech(s?.text));
  const speech = tidy(spoken, duration);
  const quiet = tidy(silences, duration);
  const usedTranscript = speech.length > 0;

  let found = [];
  if (usedTranscript) {
    for (const gap of complement(speech, duration)) {
      const length = gap.end - gap.start;
      if (length + EPS < minGap) continue;
      const before = spoken
        .filter((s) => Number(s.end) <= gap.start + 0.5 && Number(s.end) >= gap.start - PHRASE_WINDOW_SECONDS)
        .sort((a, b) => Number(a.start) - Number(b.start))
        .map((s) => (typeof s.text === "string" ? s.text : ""))
        .join(" ");
      const atEdge = gap.start <= EPS || gap.end >= duration - EPS;
      let reason = null;
      if (hasBreakPhrase(before)) reason = "phrase";
      else if (overlap(quiet, gap) / length >= SILENT_SHARE) reason = "silence";
      else if (!atEdge && length + EPS >= 2 * minGap) reason = "transcript";
      if (reason) found.push({ ...gap, reason });
    }
    const transcriptOnly = found.filter((c) => c.reason === "transcript").reduce((n, c) => n + (c.end - c.start), 0);
    if (duration > 0 && transcriptOnly / duration > TRANSCRIPT_ONLY_MAX_SHARE) {
      found = found.filter((c) => c.reason !== "transcript");
    }
  } else {
    for (const run of tidy(silences, duration, BRIDGE_SECONDS)) {
      if (run.end - run.start + EPS >= minGap) found.push({ ...run, reason: "silence" });
    }
  }

  const cuts = [];
  for (const c of found) {
    const start = c.start <= EPS ? 0 : c.start + pad;
    const end = c.end >= duration - EPS ? duration : c.end - pad;
    if (end - start + EPS < MIN_CUT_SECONDS) continue;
    cuts.push({ start: round(start), end: round(end), reason: c.reason });
  }

  const keep = complement(cuts, duration)
    .filter((k) => k.end - k.start > 0.05)
    .map((k) => ({ start: round(k.start), end: round(k.end) }));
  const trimmed = keep.reduce((n, k) => n + (k.end - k.start), 0);
  return {
    keep,
    cuts,
    summary: {
      originalSeconds: round(duration),
      trimmedSeconds: round(trimmed),
      removedSeconds: round(duration - trimmed),
      cuts: cuts.length,
    },
    usedTranscript,
  };
}

function clock(text) {
  const parts = text.replace(",", ".").split(":").map(Number);
  return parts.reduce((n, p) => n * 60 + p, 0);
}

/* WEBVTT → [{ start, end, text }]. YouTube's automatic captions roll: each
   line is shown again in the next cue. A line that the cue before it also
   had is not counted again, so a segment starts when its words start. */
export function vttToSegments(vtt) {
  const out = [];
  const lines = String(vtt ?? "").split(/\r?\n/);
  const stamp = "((?:\\d+:)?\\d{1,2}:\\d{2}[.,]\\d{1,3})";
  const cue = new RegExp(`^\\s*${stamp}\\s+-->\\s+${stamp}`);
  let previous = new Set();
  for (let i = 0; i < lines.length; i++) {
    const m = cue.exec(lines[i]);
    if (!m) continue;
    const start = clock(m[1]);
    const end = clock(m[2]);
    const shown = [];
    // YouTube writes a line of one space inside a cue: only "" ends a cue.
    for (i++; i < lines.length && lines[i] !== ""; i++) {
      const text = lines[i].replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
      if (text) shown.push(text);
    }
    const fresh = shown.filter((t) => !previous.has(t));
    previous = new Set(shown);
    if (fresh.length && end > start) out.push({ start, end, text: fresh.join(" ") });
  }
  return out;
}

/* The intervals in ffmpeg's silencedetect lines (stderr). A silence that is
   still open at the end of the file ends at `durationSeconds`. */
export function parseSilenceDetect(stderr, durationSeconds) {
  const out = [];
  let open = null;
  const re = /silence_(start|end):\s*(-?\d+(?:\.\d+)?)/g;
  for (let m; (m = re.exec(String(stderr ?? ""))); ) {
    const t = Math.max(0, Number(m[2]));
    if (m[1] === "start") open = t;
    else if (open !== null) {
      if (t > open) out.push({ start: open, end: t });
      open = null;
    }
  }
  if (open !== null && Number.isFinite(durationSeconds) && durationSeconds > open) out.push({ start: open, end: durationSeconds });
  return out;
}

/* What `ffmpeg -i <file>` prints about the file: its length and streams. */
export function parseMediaInfo(stderr) {
  const text = String(stderr ?? "");
  const d = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(text);
  return {
    durationSeconds: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null,
    hasVideo: /Stream #\d+:\d+.*: Video: (?!.*\(attached pic\))/.test(text),
    hasAudio: /Stream #\d+:\d+.*: Audio: /.test(text),
  };
}

/* The H.264 encoder to use, from `ffmpeg -encoders`. Not every ffmpeg build
   has libx264. null: none found (ffmpeg then picks its own for .mp4). */
export function pickVideoEncoder(encodersText, platform) {
  const has = (name) => new RegExp(`^\\s*V\\S*\\s+${name}\\s`, "m").test(String(encodersText ?? ""));
  if (has("libx264")) return "libx264";
  if (platform === "darwin" && has("h264_videotoolbox")) return "h264_videotoolbox";
  if (has("libopenh264")) return "libopenh264";
  if (has("mpeg4")) return "mpeg4";
  return null;
}

/* The ffmpeg arguments that write the kept intervals of `input` to `output`
   (.mp4). Each interval is read with its own seek and the pieces are joined
   by the concat filter, so sound and picture stay in step at every cut.
   Only numbers and the two paths go in; nothing here comes from a link. */
export function renderArgs({ input, output, keep, hasVideo = true, hasAudio = true, encoder = "libx264" }) {
  if (!Array.isArray(keep) || keep.length === 0) throw new Error("Nothing to keep.");
  if (!hasVideo && !hasAudio) throw new Error("The file has no video and no sound.");
  const args = ["-hide_banner", "-nostdin", "-nostats", "-y", "-progress", "pipe:1"];
  for (const k of keep) args.push("-ss", Number(k.start).toFixed(3), "-to", Number(k.end).toFixed(3), "-i", input);
  let pads = "";
  keep.forEach((_, i) => {
    if (hasVideo) pads += `[${i}:v:0]`;
    if (hasAudio) pads += `[${i}:a:0]`;
  });
  const outs = `${hasVideo ? "[v]" : ""}${hasAudio ? "[a]" : ""}`;
  args.push("-filter_complex", `${pads}concat=n=${keep.length}:v=${hasVideo ? 1 : 0}:a=${hasAudio ? 1 : 0}${outs}`);
  if (hasVideo) {
    args.push("-map", "[v]");
    if (encoder) args.push("-c:v", encoder);
    if (encoder === "libx264") args.push("-preset", "veryfast", "-crf", "23");
    else if (encoder === "h264_videotoolbox") args.push("-b:v", "2500k");
    else if (encoder === "mpeg4") args.push("-q:v", "5");
    args.push("-pix_fmt", "yuv420p");
  }
  if (hasAudio) args.push("-map", "[a]", "-c:a", "aac", "-b:a", "128k");
  args.push("-movflags", "+faststart", "-f", "mp4", output);
  return args;
}
