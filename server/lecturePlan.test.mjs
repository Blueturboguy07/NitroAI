/* The cut planner (lecturePlan.mjs) is pure: every test here gives it
 * numbers and text and reads numbers back. No file, no ffmpeg, no network. */
import { describe, expect, it } from "vitest";
import {
  PLAN_DEFAULTS,
  hasBreakPhrase,
  parseMediaInfo,
  parseSilenceDetect,
  pickVideoEncoder,
  planCuts,
  renderArgs,
  vttToSegments,
} from "./lecturePlan.mjs";

/* Speech in 5-second caption segments from `from` to `to`. */
function talk(from, to, text = "so the derivative of x squared is two x") {
  const out = [];
  for (let t = from; t < to; t += 5) out.push({ start: t, end: Math.min(to, t + 5), text });
  return out;
}

describe("planCuts: silence only (no transcript)", () => {
  it("cuts a long silence and keeps the padding on both sides", () => {
    const plan = planCuts({ silences: [{ start: 100, end: 400 }], durationSeconds: 600, minGapSeconds: 30, padSeconds: 2 });
    expect(plan.cuts).toEqual([{ start: 102, end: 398, reason: "silence" }]);
    expect(plan.keep).toEqual([{ start: 0, end: 102 }, { start: 398, end: 600 }]);
    expect(plan.summary).toEqual({ originalSeconds: 600, trimmedSeconds: 304, removedSeconds: 296, cuts: 1 });
    expect(plan.usedTranscript).toBe(false);
  });

  it("does NOT cut short pauses", () => {
    const silences = [{ start: 10, end: 13 }, { start: 50, end: 62 }, { start: 200, end: 229.5 }];
    const plan = planCuts({ silences, durationSeconds: 300, minGapSeconds: 30, padSeconds: 1 });
    expect(plan.cuts).toEqual([]);
    expect(plan.keep).toEqual([{ start: 0, end: 300 }]);
    expect(plan.summary).toMatchObject({ trimmedSeconds: 300, removedSeconds: 0, cuts: 0 });
  });

  it("a gap of exactly the minimum is cut; one just under it is not", () => {
    const at = planCuts({ silences: [{ start: 10, end: 40 }], durationSeconds: 100, minGapSeconds: 30, padSeconds: 0 });
    expect(at.summary.cuts).toBe(1);
    const under = planCuts({ silences: [{ start: 10, end: 39.9 }], durationSeconds: 100, minGapSeconds: 30, padSeconds: 0 });
    expect(under.summary.cuts).toBe(0);
  });

  it("a cough inside the silence does not split it; real sound of 3 seconds does", () => {
    const cough = planCuts({
      silences: [{ start: 100, end: 118 }, { start: 118.6, end: 140 }],
      durationSeconds: 300, minGapSeconds: 30, padSeconds: 1,
    });
    expect(cough.cuts).toEqual([{ start: 101, end: 139, reason: "silence" }]);
    const sound = planCuts({
      silences: [{ start: 100, end: 118 }, { start: 121, end: 140 }],
      durationSeconds: 300, minGapSeconds: 30, padSeconds: 1,
    });
    expect(sound.cuts).toEqual([]);
  });

  it("overlapping, unsorted and repeated intervals are merged first", () => {
    const silences = [{ start: 150, end: 200 }, { start: 100, end: 160 }, { start: 100, end: 160 }, { start: 190, end: 210 }];
    const plan = planCuts({ silences, durationSeconds: 400, minGapSeconds: 30, padSeconds: 0 });
    expect(plan.cuts).toEqual([{ start: 100, end: 210, reason: "silence" }]);
    expect(plan.summary).toMatchObject({ trimmedSeconds: 290, cuts: 1 });
  });

  it("no padding at the very start or the very end of the video", () => {
    const plan = planCuts({ silences: [{ start: 0, end: 60 }, { start: 240, end: 300 }], durationSeconds: 300, minGapSeconds: 30, padSeconds: 2 });
    expect(plan.cuts).toEqual([{ start: 0, end: 58, reason: "silence" }, { start: 242, end: 300, reason: "silence" }]);
    expect(plan.keep).toEqual([{ start: 58, end: 242 }]);
  });

  it("padding larger than half the gap leaves nothing to cut", () => {
    const plan = planCuts({ silences: [{ start: 10, end: 20 }], durationSeconds: 60, minGapSeconds: 5, padSeconds: 5 });
    expect(plan.cuts).toEqual([]);
    expect(plan.summary.trimmedSeconds).toBe(60);
  });

  it("intervals outside the video are clamped; bad entries are dropped", () => {
    const silences = [{ start: -5, end: 40 }, { start: 90, end: 500 }, { start: "x", end: 3 }, { start: 50, end: 50 }, null, { start: 70, end: 60 }];
    const plan = planCuts({ silences, durationSeconds: 120, minGapSeconds: 30, padSeconds: 0 });
    expect(plan.cuts).toEqual([{ start: 0, end: 40, reason: "silence" }, { start: 90, end: 120, reason: "silence" }]);
    expect(plan.keep).toEqual([{ start: 40, end: 90 }]);
  });
});

describe("planCuts: empty inputs", () => {
  it("nothing at all", () => {
    expect(planCuts()).toEqual({ keep: [], cuts: [], summary: { originalSeconds: 0, trimmedSeconds: 0, removedSeconds: 0, cuts: 0 }, usedTranscript: false });
    expect(planCuts({ silences: [], segments: [] }).keep).toEqual([]);
  });

  it("no silence and no transcript: the whole video stays", () => {
    const plan = planCuts({ silences: [], segments: [], durationSeconds: 1200 });
    expect(plan.keep).toEqual([{ start: 0, end: 1200 }]);
    expect(plan.summary).toEqual({ originalSeconds: 1200, trimmedSeconds: 1200, removedSeconds: 0, cuts: 0 });
  });

  it("without a duration the video ends at the last interval", () => {
    const plan = planCuts({ silences: [{ start: 10, end: 70 }], segments: [], minGapSeconds: 30, padSeconds: 0 });
    expect(plan.summary.originalSeconds).toBe(70);
    expect(plan.keep).toEqual([{ start: 0, end: 10 }]);
  });

  it("the defaults are 30 seconds and 1.5 seconds", () => {
    expect(PLAN_DEFAULTS).toEqual({ minGapSeconds: 30, padSeconds: 1.5 });
    const plan = planCuts({ silences: [{ start: 100, end: 200 }], durationSeconds: 300 });
    expect(plan.cuts).toEqual([{ start: 101.5, end: 198.5, reason: "silence" }]);
  });
});

describe("planCuts: transcript", () => {
  it("noisy room: no silence at all, the teacher's phrase and the gap in the captions give the cut", () => {
    const segments = [
      ...talk(0, 295),
      { start: 295, end: 300, text: "OK, take a few minutes on this one" },
      ...talk(540, 900, "all right, let's look at the answer together"),
    ];
    const plan = planCuts({ silences: [], segments, durationSeconds: 900, minGapSeconds: 30, padSeconds: 1.5 });
    expect(plan.cuts).toEqual([{ start: 301.5, end: 538.5, reason: "phrase" }]);
    expect(plan.summary).toEqual({ originalSeconds: 900, trimmedSeconds: 663, removedSeconds: 237, cuts: 1 });
    expect(plan.usedTranscript).toBe(true);
  });

  it("noisy room, no phrase: a caption gap of twice the minimum is cut; a shorter one is not", () => {
    const long = planCuts({ silences: [], segments: [...talk(0, 100), ...talk(160, 300)], durationSeconds: 300, minGapSeconds: 30, padSeconds: 0 });
    expect(long.cuts).toEqual([{ start: 100, end: 160, reason: "transcript" }]);
    const short = planCuts({ silences: [], segments: [...talk(0, 100), ...talk(150, 300)], durationSeconds: 300, minGapSeconds: 30, padSeconds: 0 });
    expect(short.cuts).toEqual([]);
  });

  it("a phrase makes a gap of the minimum length enough", () => {
    const segments = [...talk(0, 95), { start: 95, end: 100, text: "I'll give you two minutes" }, ...talk(135, 300)];
    const plan = planCuts({ silences: [], segments, durationSeconds: 300, minGapSeconds: 30, padSeconds: 0 });
    expect(plan.cuts).toEqual([{ start: 100, end: 135, reason: "phrase" }]);
  });

  it("a phrase that runs over two caption segments is still found", () => {
    const segments = [
      ...talk(0, 90),
      { start: 90, end: 95, text: "so why don't you take a" },
      { start: 95, end: 100, text: "couple of minutes and try it" },
      ...talk(140, 300),
    ];
    expect(planCuts({ silences: [], segments, durationSeconds: 300, minGapSeconds: 30, padSeconds: 0 }).cuts).toEqual([
      { start: 100, end: 140, reason: "phrase" },
    ]);
  });

  it("a phrase long before the gap does not count", () => {
    const segments = [{ start: 0, end: 5, text: "later you will take a few minutes on this" }, ...talk(5, 100), ...talk(140, 300)];
    expect(planCuts({ silences: [], segments, durationSeconds: 300, minGapSeconds: 30, padSeconds: 0 }).cuts).toEqual([]);
  });

  it("silence over at least half of a caption gap cuts the whole gap", () => {
    const segments = [...talk(0, 100), ...talk(140, 300)];
    const half = planCuts({ silences: [{ start: 105, end: 127 }], segments, durationSeconds: 300, minGapSeconds: 30, padSeconds: 1 });
    expect(half.cuts).toEqual([{ start: 101, end: 139, reason: "silence" }]);
    const little = planCuts({ silences: [{ start: 105, end: 115 }], segments, durationSeconds: 300, minGapSeconds: 30, padSeconds: 1 });
    expect(little.cuts).toEqual([]);
  });

  it("short pauses between sentences are NOT cut, with or without silence", () => {
    const segments = [...talk(0, 60), ...talk(72, 120), ...talk(140, 300)];
    const silences = [{ start: 60, end: 72 }, { start: 120, end: 140 }];
    const plan = planCuts({ silences, segments, durationSeconds: 300, minGapSeconds: 30, padSeconds: 1.5 });
    expect(plan.cuts).toEqual([]);
    expect(plan.keep).toEqual([{ start: 0, end: 300 }]);
  });

  it("speech is never cut, even when ffmpeg calls it silence (a quiet voice)", () => {
    const segments = talk(0, 300);
    const plan = planCuts({ silences: [{ start: 50, end: 250 }], segments, durationSeconds: 300, minGapSeconds: 30, padSeconds: 0 });
    expect(plan.cuts).toEqual([]);
  });

  it("the cut stops where speech picks back up, not where the silence ends", () => {
    const segments = [...talk(0, 100), ...talk(200, 300)];
    const plan = planCuts({ silences: [{ start: 90, end: 230 }], segments, durationSeconds: 300, minGapSeconds: 30, padSeconds: 2 });
    expect(plan.cuts).toEqual([{ start: 102, end: 198, reason: "silence" }]);
  });

  it("[Music] and (silence) captions are not speech", () => {
    const segments = [...talk(0, 100), { start: 100, end: 190, text: "[Music]" }, { start: 190, end: 200, text: "(students working)" }, ...talk(200, 300)];
    const plan = planCuts({ silences: [], segments, durationSeconds: 300, minGapSeconds: 30, padSeconds: 0 });
    expect(plan.cuts).toEqual([{ start: 100, end: 200, reason: "transcript" }]);
  });

  it("overlapping caption segments (rolling captions) are merged", () => {
    const segments = [
      { start: 0, end: 50, text: "first" }, { start: 40, end: 100, text: "second" }, { start: 99, end: 100, text: "second" },
      { start: 200, end: 250, text: "third" }, { start: 230, end: 300, text: "fourth" },
    ];
    const plan = planCuts({ silences: [], segments, durationSeconds: 300, minGapSeconds: 30, padSeconds: 0 });
    expect(plan.cuts).toEqual([{ start: 100, end: 200, reason: "transcript" }]);
  });

  it("captions that stop early do not cut the rest of the video", () => {
    // Captions cover 0-100 of a 1,000-second video; the room is not silent.
    const tail = planCuts({ silences: [], segments: talk(0, 100), durationSeconds: 1000, minGapSeconds: 30, padSeconds: 0 });
    expect(tail.cuts).toEqual([]);
    // The same in the middle: transcript-only cuts over half of the video are dropped.
    const middle = planCuts({ silences: [], segments: [...talk(0, 100), ...talk(900, 1000)], durationSeconds: 1000, minGapSeconds: 30, padSeconds: 0 });
    expect(middle.cuts).toEqual([]);
    expect(middle.keep).toEqual([{ start: 0, end: 1000 }]);
  });

  it("but a silent start or end is cut, and a cut that silence confirms survives the half-video rule", () => {
    const segments = [...talk(100, 200), ...talk(900, 1000)];
    const silences = [{ start: 0, end: 95 }, { start: 210, end: 890 }];
    const plan = planCuts({ silences, segments, durationSeconds: 1000, minGapSeconds: 30, padSeconds: 0 });
    expect(plan.cuts).toEqual([{ start: 0, end: 100, reason: "silence" }, { start: 200, end: 900, reason: "silence" }]);
    expect(plan.summary).toEqual({ originalSeconds: 1000, trimmedSeconds: 200, removedSeconds: 800, cuts: 2 });
  });

  it("several breaks in one lecture: the summary counts each", () => {
    const segments = [
      ...talk(0, 595), { start: 595, end: 600, text: "pause the video and try it" },
      ...talk(900, 1495), { start: 1495, end: 1500, text: "work on this with your neighbor" },
      ...talk(1800, 2400),
    ];
    const silences = [{ start: 610, end: 890 }];
    const plan = planCuts({ silences, segments, durationSeconds: 2400, minGapSeconds: 30, padSeconds: 1.5 });
    expect(plan.summary).toEqual({ originalSeconds: 2400, trimmedSeconds: 1806, removedSeconds: 594, cuts: 2 });
    expect(plan.keep).toEqual([{ start: 0, end: 601.5 }, { start: 898.5, end: 1501.5 }, { start: 1798.5, end: 2400 }]);
  });

  it("the kept intervals and the cuts together are the whole video, in order, with no overlap", () => {
    const segments = [...talk(0, 100), ...talk(170, 300), ...talk(420, 600)];
    const silences = [{ start: 300, end: 420 }, { start: 100, end: 120 }];
    const plan = planCuts({ silences, segments, durationSeconds: 600, minGapSeconds: 30, padSeconds: 1 });
    const all = [...plan.keep, ...plan.cuts].sort((a, b) => a.start - b.start);
    expect(all[0].start).toBe(0);
    expect(all[all.length - 1].end).toBe(600);
    for (let i = 1; i < all.length; i++) expect(all[i].start).toBe(all[i - 1].end);
    expect(plan.summary.trimmedSeconds + plan.summary.removedSeconds).toBe(600);
  });
});

describe("solve-break phrases", () => {
  it.each([
    "Take a few minutes on this",
    "take five minutes and see what you get",
    "I'll give you about three minutes",
    "I’ll give you a minute",
    "I'm going to give you some time",
    "work on this with the person next to you",
    "go ahead and work through the next problem",
    "Pause the video now",
    "try this on your own",
    "try it yourself first",
    "give it a shot",
    "you have 2 minutes to finish",
    "talk with your neighbor about part b",
  ])("%s", (text) => expect(hasBreakPhrase(text)).toBe(true));

  it.each([
    "this takes a few steps",
    "the work done on this object is force times distance",
    "it took me five minutes to drive here",
    "we will work this out together now",
    "",
  ])("not a break: %s", (text) => expect(hasBreakPhrase(text)).toBe(false));
});

describe("vttToSegments", () => {
  it("reads cue times with and without hours", () => {
    const vtt = "WEBVTT\nKind: captions\nLanguage: en\n\n00:01.000 --> 00:04.500\nHello class\n\n01:02:03.250 --> 01:02:05.000 align:start position:0%\nTake a few minutes\non this\n";
    expect(vttToSegments(vtt)).toEqual([
      { start: 1, end: 4.5, text: "Hello class" },
      { start: 3723.25, end: 3725, text: "Take a few minutes on this" },
    ]);
  });

  it("rolling automatic captions: a repeated line is not a new segment", () => {
    const vtt = [
      "WEBVTT", "",
      "00:00:00.000 --> 00:00:02.000", " ", "today<00:00:00.500><c> we</c><00:00:01.000><c> start</c>", "",
      "00:00:02.000 --> 00:00:02.010", "today we start", "",
      "00:00:02.010 --> 00:00:04.000", "today we start", "with<00:00:02.500><c> limits</c>", "",
      "00:05:00.000 --> 00:05:03.000", "with limits", "welcome back", "",
    ].join("\n");
    expect(vttToSegments(vtt)).toEqual([
      { start: 0, end: 2, text: "today we start" },
      { start: 2.01, end: 4, text: "with limits" },
      { start: 300, end: 303, text: "welcome back" },
    ]);
  });

  it("empty or not a caption file", () => {
    expect(vttToSegments("")).toEqual([]);
    expect(vttToSegments(undefined)).toEqual([]);
    expect(vttToSegments("just some words\n--> no times")).toEqual([]);
  });
});

describe("ffmpeg text", () => {
  it("parseSilenceDetect reads start and end pairs, and closes an open one at the end", () => {
    const err = [
      "[silencedetect @ 0x1] silence_start: 3.0005",
      "[silencedetect @ 0x1] silence_end: 11.002 | silence_duration: 8.0015",
      "frame= 100",
      "[silencedetect @ 0x1] silence_start: -0.01",
      "[silencedetect @ 0x1] silence_end: 2 | silence_duration: 2.01",
      "[silencedetect @ 0x1] silence_start: 50",
    ].join("\n");
    expect(parseSilenceDetect(err, 60)).toEqual([{ start: 3.0005, end: 11.002 }, { start: 0, end: 2 }, { start: 50, end: 60 }]);
    expect(parseSilenceDetect(err)).toHaveLength(2);
    expect(parseSilenceDetect("")).toEqual([]);
  });

  it("parseMediaInfo reads the length and the streams", () => {
    const err = "Input #0, mov,mp4\n  Duration: 00:52:10.04, start: 0.000000, bitrate: 800 kb/s\n  Stream #0:0[0x1](und): Video: h264 (High), yuv420p\n  Stream #0:1[0x2](und): Audio: aac (LC), 44100 Hz";
    expect(parseMediaInfo(err)).toEqual({ durationSeconds: 3130.04, hasVideo: true, hasAudio: true });
    expect(parseMediaInfo("Duration: 00:00:05.00\n Stream #0:0: Audio: mp3")).toEqual({ durationSeconds: 5, hasVideo: false, hasAudio: true });
    expect(parseMediaInfo("Stream #0:0: Audio: mp3\n Stream #0:1: Video: mjpeg (attached pic)").hasVideo).toBe(false);
    expect(parseMediaInfo("nothing")).toEqual({ durationSeconds: null, hasVideo: false, hasAudio: false });
  });

  it("pickVideoEncoder prefers libx264, then what the build has", () => {
    const line = (n) => ` V....D ${n}              some encoder`;
    expect(pickVideoEncoder([line("mpeg4"), line("libx264"), line("h264_videotoolbox")].join("\n"), "darwin")).toBe("libx264");
    expect(pickVideoEncoder([line("mpeg4"), line("h264_videotoolbox")].join("\n"), "darwin")).toBe("h264_videotoolbox");
    expect(pickVideoEncoder([line("mpeg4"), line("h264_videotoolbox")].join("\n"), "linux")).toBe("mpeg4");
    expect(pickVideoEncoder(" A....D aac   AAC", "linux")).toBe(null);
  });

  it("renderArgs: one seek per kept interval, one concat, and only numbers and paths", () => {
    const args = renderArgs({ input: "/t/in.mp4", output: "/t/out.mp4", keep: [{ start: 0, end: 4.5 }, { start: 10.25, end: 14 }] });
    expect(args.filter((a) => a === "-i")).toHaveLength(2);
    expect(args.join(" ")).toContain("-ss 0.000 -to 4.500 -i /t/in.mp4 -ss 10.250 -to 14.000 -i /t/in.mp4");
    expect(args[args.indexOf("-filter_complex") + 1]).toBe("[0:v:0][0:a:0][1:v:0][1:a:0]concat=n=2:v=1:a=1[v][a]");
    expect(args[args.length - 1]).toBe("/t/out.mp4");
    const soundOnly = renderArgs({ input: "a", output: "b", keep: [{ start: 0, end: 1 }], hasVideo: false });
    expect(soundOnly[soundOnly.indexOf("-filter_complex") + 1]).toBe("[0:a:0]concat=n=1:v=0:a=1[a]");
    expect(soundOnly).not.toContain("-c:v");
    expect(() => renderArgs({ input: "a", output: "b", keep: [] })).toThrow();
  });
});
