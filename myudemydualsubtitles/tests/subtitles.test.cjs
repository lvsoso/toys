"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const {parse_subtitles, to_srt, lesson_context, max_bytes} = require("../subtitles.js");

test("SRT preserves bilingual text, BOM, CRLF, milliseconds and overlapping cues", () => {
  const cues = parse_subtitles("\uFEFF1\r\n00:00:01,005 --> 00:00:03,090\r\nHello\r\n你好\r\n\r\n2\r\n00:00:02,000 --> 00:00:04,000\r\nWorld");
  assert.equal(cues[0].start, 1.005);
  assert.equal(cues[0].end, 3.09);
  assert.equal(cues[0].text, "Hello\n你好");
  assert.deepEqual(parse_subtitles(to_srt(cues)), cues);
});

test("WebVTT supports cue IDs/settings and skips metadata, not cue text", () => {
  const cues = parse_subtitles("WEBVTT\nKind: captions\n\nNOTE explanation\nignored\n\nSTYLE\n::cue {color:red}\n\nREGION\nid:region\n\nintro\n00:01.005 --> 00:02.500 align:start\n<v Teacher><b>A &amp; B</b> &#x4f60;&#22909;\n\n00:03.000 --> 00:04.000\nSecond");
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, "A & B 你好");
  assert.equal(cues[0].end, 2.5);
});

test("invalid files fail without a partially imported track", () => {
  for (const text of ["", "<html>login</html>", "WEBVTT", "1\n00:00:05,000 --> 00:00:01,000\nwrong",
    "1\n00:61:00,000 --> 00:62:00,000\nwrong", "1\n00:00:01,000 --> 00:00:02,000\n",
    "1\n00:00:01,000 --> 00:00:02,000\nvalid\n\nBROKEN"]) {
    assert.throws(() => parse_subtitles(text));
  }
  assert.throws(() => parse_subtitles("x".repeat(max_bytes + 1)));
});

test("blank cues are skipped", () => {
  const cues = parse_subtitles("1\n00:00:01,000 --> 00:00:02,000\n\n\n2\n00:00:03,000 --> 00:00:04,000\nkept");
  assert.deepEqual(cues.map((cue) => cue.text), ["kept"]);
});

test("SRT export does not wrap at 24 hours and pads fractional times", () => {
  const srt = to_srt([{start: 90001.005, end: 90002.05, text: "long"}]);
  assert.match(srt, /25:00:01,005 --> 25:00:02,050/);
  assert.equal(parse_subtitles(srt)[0].start, 90001.005);
});

test("cache identity isolates host, course and lesson but ignores playback position", () => {
  const url = "https://www.udemy.com/course/python/learn/lecture/123";
  const context = lesson_context(url);
  assert.equal(lesson_context(`${url}?start=40#overview`).key, context.key);
  for (const other of [url.replace("www.", "company."), url.replace("python", "go"), url.replace("123", "124")]) {
    assert.notEqual(lesson_context(other).key, context.key);
  }
  assert.equal(lesson_context("https://www.udemy.com/course/python/"), null);
  assert.equal(lesson_context(url.replace("udemy.com", "udemy.com.evil.test")), null);
});
