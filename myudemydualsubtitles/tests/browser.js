"use strict";

// Browser-only fixture: run the real content script with local Chrome storage/message stubs.
const fixture_storage = {};
let fixture_listener;
let fixture_lesson = "123";
const original_context = SubtitleTools.lesson_context;
SubtitleTools.lesson_context = () => original_context(
  `https://www.udemy.com/course/test/learn/lecture/${fixture_lesson}`,
);
globalThis.chrome = {runtime: {id: "fixture", onMessage: {addListener(listener) { fixture_listener = listener; }}},
  storage: {onChanged: {addListener() {}}, local: {async get(key) { return Object.fromEntries((Array.isArray(key) ? key : [key]).map((item) => [item, fixture_storage[item]])); },
    async set(value) { Object.assign(fixture_storage, value); }}}};

/** Exercise actual browser message handling rather than duplicating content logic. */
function send(action, payload = {}) {
  return new Promise((resolve, reject) => fixture_listener(
    {source: "myuds:popup", action, ...payload}, {id: "fixture"},
    (response) => response.ok ? resolve(response) : reject(new Error(response.error)),
  ));
}

/** Fail the fixture immediately if native behavior differs from expectations. */
function check(condition, description) {
  if (!condition) throw new Error(description);
}

/** Create local media with a seekable timeline, without a network or bundled media dependency. */
function media_url() {
  const samples = 8000 * 8;
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  /** Write an ASCII WAV header tag. */
  function tag(offset, text) {
    Array.from(text).forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  }
  tag(0, "RIFF"); view.setUint32(4, buffer.byteLength - 8, true); tag(8, "WAVE");
  tag(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, 8000, true); view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, "data");
  view.setUint32(40, samples * 2, true);
  return URL.createObjectURL(new Blob([buffer], {type: "audio/wav"}));
}

/** Seek the real HTMLVideoElement and wait for its track to update. */
async function seek(video, seconds) {
  await new Promise((resolve) => {
    video.addEventListener("seeked", resolve, {once: true});
    video.currentTime = seconds;
  });
}

/** Check native pause/seek/rate handling, import persistence, and lesson isolation in Chrome. */
async function run_browser_test() {
  const result = document.getElementById("result");
  const video = document.querySelector("video");
  try {
    await new Promise((resolve, reject) => {
      video.addEventListener("loadedmetadata", resolve, {once: true});
      video.addEventListener("error", () => reject(new Error("fixture media failed")), {once: true});
      video.src = media_url();
    });
    await send("import", {name: "bilingual.srt", text:
      "1\n00:00:01,000 --> 00:00:03,000\nHello\n你好\n\n2\n00:00:04,000 --> 00:00:06,000\nWorld\n世界"});
    const track = video.textTracks[0];
    check(track.mode === "hidden" && track.cues.length === 2, "import/native track");
    await seek(video, 2);
    check(track.activeCues[0]?.getCueAsHTML().textContent === "Hello\n你好", "paused subtitle");
    const overlay = document.querySelector(".myuds-subtitle-overlay");
    check(overlay && !overlay.hidden && overlay.textContent === "Hello\n你好", "overlay plain text");
    check(getComputedStyle(overlay).pointerEvents === "none", "overlay does not block controls");
    check(overlay.getBoundingClientRect().width < video.getBoundingClientRect().width / 2,
      "short subtitle background hugs text");
    video.playbackRate = 2;
    await seek(video, 5);
    check(track.activeCues[0]?.getCueAsHTML().textContent === "World\n世界", "forward seek at 2x");
    await seek(video, 2);
    check(track.activeCues[0]?.getCueAsHTML().textContent === "Hello\n你好", "backward seek");
    await seek(video, 3.5);
    check(track.activeCues.length === 0, "gap clears subtitle");
    check(overlay.hidden, "gap hides overlay");
    await send("visibility", {visible: false});
    check(track.mode === "disabled", "hide");
    await send("visibility", {visible: true});
    fixture_lesson = "456";
    await send("status");
    check(track.mode === "disabled", "lesson isolation");
    fixture_lesson = "123";
    const restored = await send("status");
    check(restored.cue_count === 2 && track.mode === "hidden", "restore cached lesson");
    check(video.textTracks.length === 1, "no duplicate tracks");
    await send("subtitle_style", {style: {font_size: 36, position: 25}});
    check(track.cues[0].line === 25 && track.cues[0].snapToLines === false, "percentage position");
    check(video.style.getPropertyValue("--myuds-font-size") === "36px", "font preference");
    await seek(video, 2);
    check(getComputedStyle(overlay).fontSize === "36px", "overlay font size");
    await send("subtitle_style", {reset: true});
    check(track.cues[0].line === 85, "reset style");
    const source = "and a system can fail either way while\nlooking perfectly healthy in the other\n系统可能因其中任何一点而失效，\n但在另一个";
    await send("import", {text: `1\n00:00:01,000 --> 00:00:03,000\n${source}`});
    await new Promise((resolve) => requestAnimationFrame(resolve));
    check(overlay.textContent === "and a system can fail either way while looking perfectly healthy in the other\n系统可能因其中任何一点而失效，但在另一个", "hard wraps flattened by language");
    check(track.cues[0].getCueAsHTML().textContent === source, "stored cue text remains unchanged");
    check(overlay.getBoundingClientRect().width <= video.getBoundingClientRect().width * 0.92 + 1,
      "long subtitle stays within video width");
    check(overlay.scrollWidth <= overlay.clientWidth + 1, "long subtitle wraps without horizontal overflow");
    await send("subtitle_style", {style: {font_size: 24, position: 100}});
    check(Math.abs(overlay.getBoundingClientRect().bottom - video.getBoundingClientRect().bottom) < 1,
      "100 percent aligns overlay bottom with video bottom");
    await send("subtitle_style", {reset: true});
    result.textContent = "PASS: overlay rendering, native timing, import, pause, forward/backward seek, 2x, gap, visibility, cache restore, lesson isolation";
  } catch (error) {
    result.textContent = `FAIL: ${error.message}`;
  }
}

window.addEventListener("load", run_browser_test);
