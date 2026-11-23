"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const SubtitleTools = require("../subtitles.js");
const source = fs.readFileSync(path.join(__dirname, "../content.js"), "utf8");
const sample = "1\n00:00:01,000 --> 00:00:03,000\nHello\n你好";

/** Run the real content script against a minimal browser/Chrome storage boundary. */
function harness(storage = {}) {
  let listener;
  let poll;
  let reject_write = false;
  let storage_changed;
  const properties = {};
  const elements = [];
  const host = {appendChild(node) { node.parentNode = this; }};
  const video = {currentTime: 2, addEventListener() {}, removeEventListener() {},
    getBoundingClientRect() { return {left: 20, top: 10, width: 640, height: 360}; }, style: {setProperty(key, value) { properties[key] = value; }}, tracks: [], addTextTrack() {
    const track = {mode: "disabled", cues: [], addEventListener() {},
      get activeCues() { return this.cues.filter((cue) => video.currentTime >= cue.startTime && video.currentTime < cue.endTime); }, addCue(cue) { this.cues.push(cue); },
      removeCue(cue) { this.cues.splice(this.cues.indexOf(cue), 1); }};
    this.tracks.push(track);
    return track;
  }};
  const context = {
    SubtitleTools, location: {href: "https://www.udemy.com/course/python/learn/lecture/123", origin: "https://www.udemy.com"},
    chrome: {runtime: {id: "test", onMessage: {addListener(value) { listener = value; }}},
      storage: {onChanged: {addListener(handler) { storage_changed = handler; }}, local: {async get(key) { return Object.fromEntries((Array.isArray(key) ? key : [key]).map((item) => [item, storage[item]])); },
        async set(value) { if (reject_write) throw new Error("quota"); Object.assign(storage, value); }}}},
    window: {addEventListener() {}},
    document: {body: host, addEventListener() {}, createElement() {
      const node = {style: {}, hidden: false, textContent: "", offsetHeight: 80};
      elements.push(node);
      return node;
    }, querySelector(selector) { return selector === "video" ? video : null; }},
    VTTCue: class { constructor(start, end, text) { this.startTime = start; this.endTime = end; this.text = text; }
      getCueAsHTML() { return {textContent: this.text.replace(/^<c.myuds-local-cue>|<\/c>$/g, "")
        .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")}; }
    },
    setInterval(value, delay) { if (delay === 300) poll = value; },
  };
  vm.runInNewContext(source, context);
  return {context, video, storage, properties, elements, storage_changed: (...args) => storage_changed(...args), poll: () => poll(), fail_writes: () => { reject_write = true; },
    send: (action, payload = {}) => new Promise((resolve) => {
      listener({source: "myuds:popup", action, ...payload}, {id: "test"}, resolve);
    })};
}

test("import persists, reload restores, and switching lessons never leaks old cues", async () => {
  const app = harness();
  const status = await app.send("status");
  assert.equal((await app.send("import", {key: status.context.key, text: sample, name: "lesson.srt"})).ok, true);
  assert.equal(app.video.tracks[0].mode, "hidden");
  assert.equal(app.video.tracks[0].cues[0].text, "<c.myuds-local-cue>Hello\n你好</c>");
  const reopened = harness(app.storage);
  assert.equal((await reopened.send("status")).cue_count, 1);
  app.context.location.href = app.context.location.href.replace("123", "456");
  app.poll();
  assert.equal((await app.send("status")).cue_count, 0);
  assert.equal(app.video.tracks[0].mode, "disabled");
  assert.equal(app.video.tracks[0].cues.length, 0);
  assert.equal((await app.send("import", {key: status.context.key, text: sample})).ok, false);
  app.context.location.href = app.context.location.href.replace("456", "123");
  assert.equal((await app.send("status")).imported_name, "lesson.srt");
});

test("quota failure or invalid import keeps previous subtitles; visibility does not erase cache", async () => {
  const app = harness();
  await app.send("import", {text: sample, name: "original.srt"});
  assert.equal((await app.send("import", {text: "invalid"})).ok, false);
  app.fail_writes();
  assert.equal((await app.send("import", {text: sample.replace("你好", "替换"), name: "new.srt"})).ok, false);
  assert.equal((await app.send("status")).imported_name, "original.srt");
  await app.send("visibility", {visible: false});
  assert.equal(app.video.tracks[0].mode, "disabled");
  assert.equal((await app.send("status")).cue_count, 1);
  await app.send("visibility", {visible: true});
  assert.equal(app.video.tracks[0].mode, "hidden");
});

test("late cache response cannot render the previous lesson", async () => {
  const app = harness();
  await app.send("status");
  let finish;
  app.context.chrome.storage.local.get = (key) => new Promise((resolve) => {
    finish = () => resolve({[key]: {text: sample, name: "late.srt"}});
  });
  app.context.location.href = app.context.location.href.replace("123", "456");
  app.poll();
  app.context.location.href = "https://www.udemy.com/course/python/";
  app.poll();
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.video.tracks.length, 0);
});

test("classic REST metadata downloads and converts a full VTT without forwarding CDN credentials", async () => {
  const app = harness();
  const calls = [];
  app.context.crypto = {randomUUID: () => "req"};
  app.context.setTimeout = setTimeout;
  app.context.clearTimeout = clearTimeout;
  app.context.URL = URL;
  app.context.AbortSignal = AbortSignal;
  let receive;
  const window = {addEventListener(type, handler) { receive = handler; }, removeEventListener() {},
    postMessage(message) { queueMicrotask(() => receive({source: window, origin: app.context.location.origin,
      data: {type: "myuds:captions:response", request_id: message.request_id, captions: []}})); }};
  app.context.window = window;
  app.context.document.querySelector = (selector) => selector === "video" ? app.video : {
    getAttribute: () => JSON.stringify({courseId: 99}),
  };
  app.context.fetch = async (url, options) => {
    calls.push({url, options});
    if (url.includes("api-2.0")) return {ok: true, json: async () => ({asset: {captions: [
      {locale_id: "en_US", video_label: "English", url: "https://a.udemycdn.com/captions.vtt"},
      {locale_id: "bad", url: "https://evil.test/file"},
    ]}})};
    return {ok: true, text: async () => "WEBVTT\n\n00:00:01.005 --> 00:00:03.050\nHello"};
  };
  const listing = await app.send("list");
  assert.equal(listing.captions.length, 1);
  assert.equal(listing.captions[0].label, "English");
  const downloaded = await app.send("download", {index: 0});
  assert.equal(downloaded.ok, true);
  assert.match(downloaded.text, /00:00:01,005 --> 00:00:03,050/);
  assert.match(calls[0].url, /subscribed-courses\/99\/lectures\/123/);
  assert.equal(calls[1].options.credentials, "omit");
  assert.equal((await app.send("download", {index: 3})).ok, false);
});

test("completed translation loads bilingual cues and is reused without a backend after reload", async () => {
  const key = SubtitleTools.lesson_context("https://www.udemy.com/course/python/learn/lecture/123").key;
  const app = harness({[`translation:${key}`]: {id: "a".repeat(64), saved: false}});
  app.context.chrome.runtime.sendMessage = async () => ({ok: true, data: {
    id: "a".repeat(64), state: "completed", done: 1, total: 1, error: "",
    cues: [{start: 1, end: 3, text: "Hello\n你好"}],
  }});
  await app.send("translation_poll");
  assert.equal((await app.send("status")).translation_status.state, "completed");
  assert.equal(app.video.tracks[0].cues[0].text, "<c.myuds-local-cue>Hello\n你好</c>");
  const reopened = harness(app.storage);
  reopened.context.chrome.runtime.sendMessage = () => { throw new Error("must not contact backend"); };
  await reopened.send("translation_poll");
  assert.equal((await reopened.send("status")).cue_count, 1);
  assert.equal((await reopened.send("status")).translation_status.state, "completed");
});

test("late translation responses never overwrite a manual import", async () => {
  const key = SubtitleTools.lesson_context("https://www.udemy.com/course/python/learn/lecture/123").key;
  const app = harness({[`translation:${key}`]: {id: "a".repeat(64), saved: false}});
  let finish;
  app.context.chrome.runtime.sendMessage = () => new Promise((resolve) => { finish = resolve; });
  const pending = app.send("translation_poll");
  await new Promise((resolve) => setImmediate(resolve));
  await app.send("import", {text: sample, name: "manual.srt"});
  finish({ok: true, data: {state: "completed", done: 1, total: 1,
    cues: [{start: 1, end: 3, text: "Old\n旧译文"}]}});
  await pending;
  assert.equal((await app.send("status")).imported_name, "manual.srt");
  assert.equal(app.storage[key].name, "manual.srt");
  assert.equal(app.storage[`translation:${key}`], null);
});

test("partial translation displays progress, failure retains prefix, retry does not resubmit", async () => {
  const key = SubtitleTools.lesson_context("https://www.udemy.com/course/python/learn/lecture/123").key;
  const app = harness({[`translation:${key}`]: {id: "a".repeat(64), saved: false}});
  const operations = [];
  app.context.chrome.runtime.sendMessage = async (message) => {
    operations.push(message.operation);
    return {ok: true, data: {state: "failed", done: 1, total: 2, error: "fixture failure",
      cues: [{start: 1, end: 3, text: "Hello\n你好"}]}};
  };
  await app.send("translation_poll");
  assert.equal((await app.send("status")).cue_count, 1);
  assert.equal(app.storage[key], undefined);
  await app.send("translation_retry");
  assert.ok(operations.includes("retry"));
  assert.ok(!operations.includes("submit"));
});

test("style changes preserve cue content and timing, persist globally and reset without deleting subtitles", async () => {
  const app = harness();
  app.context.chrome.runtime.sendMessage = () => { throw new Error("style must not translate"); };
  await app.send("import", {text: sample, name: "manual.srt"});
  const cue = app.video.tracks[0].cues[0];
  assert.equal(cue.line, 85);
  assert.equal(cue.snapToLines, false);
  const changed = await app.send("subtitle_style", {style: {font_size: 36, position: 25}});
  assert.equal(changed.ok, true);
  assert.equal(app.properties["--myuds-font-size"], "36px");
  assert.equal(app.video.tracks[0].cues[0], cue);
  assert.equal(cue.line, 25);
  assert.equal(cue.lineAlign, "end");
  assert.equal(cue.position, 50);
  assert.equal(cue.startTime, 1);
  assert.equal(cue.endTime, 3);
  const reopened = harness(app.storage);
  assert.equal((await reopened.send("status")).subtitle_style.font_size, 36);
  assert.equal(reopened.video.tracks[0].cues[0].line, 25);
  reopened.context.location.href = reopened.context.location.href.replace("123", "456");
  await reopened.send("import", {text: sample, name: "next.srt"});
  assert.equal(reopened.video.tracks[0].cues[0].line, 25);
  await reopened.send("subtitle_style", {reset: true});
  assert.equal(reopened.video.tracks[0].cues[0].line, 85);
  assert.equal(reopened.properties["--myuds-font-size"], "24px");
  assert.equal((await reopened.send("status")).cue_count, 1);
});

test("style updates honor hidden subtitles, cross-tab notifications and invalid-input boundaries", async () => {
  const app = harness();
  await app.send("import", {text: sample});
  await app.send("visibility", {visible: false});
  app.storage_changed({subtitle_style: {newValue: {font_size: 42, position: 15}}}, "local");
  assert.equal(app.video.tracks[0].mode, "disabled");
  assert.equal(app.video.tracks[0].cues[0].line, 15);
  app.storage_changed({subtitle_style: {newValue: {font_size: 20, position: 80}}}, "sync");
  assert.equal(app.video.tracks[0].cues[0].line, 15);
  for (const style of [{font_size: 200, position: 85}, {font_size: 24, position: -1},
    {font_size: "24", position: 85}, {font_size: 24, position: 20.5}]) {
    assert.equal((await app.send("subtitle_style", {style})).ok, false);
  }
  assert.equal(app.video.tracks[0].cues[0].line, 15);
  app.fail_writes();
  assert.equal((await app.send("subtitle_style", {style: {font_size: 20, position: 80}})).ok, false);
  assert.equal(app.video.tracks[0].cues[0].line, 15);
});


test("overlay uses one plain-text box, follows time, fullscreen, visibility and lesson changes", async () => {
  const app = harness();
  await app.send("import", {text: sample});
  const box = app.elements[0];
  assert.equal(box.textContent, "Hello\n你好");
  assert.equal(box.hidden, false);
  assert.ok(Math.abs(parseFloat(box.style.maxWidth) - 588.8) < 0.01);
  assert.equal(box.style.fontSize, "24px");
  app.video.currentTime = 3.5;
  app.poll();
  assert.equal(box.hidden, true);
  app.video.currentTime = 2;
  app.poll();
  assert.equal(box.hidden, false);
  const fullscreen = {appendChild(node) { node.parentNode = this; }};
  app.context.document.fullscreenElement = fullscreen;
  app.poll();
  assert.equal(box.parentNode, fullscreen);
  assert.equal(app.video.tracks[0].mode, "hidden");
  app.context.document.fullscreenElement = app.video;
  app.poll();
  assert.equal(box.hidden, true);
  assert.equal(app.video.tracks[0].mode, "showing");
  app.context.document.fullscreenElement = null;
  app.poll();
  assert.equal(box.parentNode, app.context.document.body);
  assert.equal(app.video.tracks[0].mode, "hidden");
  await app.send("visibility", {visible: false});
  assert.equal(box.hidden, true);
  await app.send("visibility", {visible: true});
  assert.equal(box.hidden, false);
  await app.send("import", {text: sample.replace("Hello", "&lt;img src=x onerror=alert(1)&gt; &amp; text")});
  assert.equal(box.textContent, "<img src=x onerror=alert(1)> & text\n你好");
  app.context.location.href = app.context.location.href.replace("123", "456");
  app.poll();
  assert.equal(box.hidden, true);
});


test("display joins same-language wraps without changing cache, timing or mixed lines", async () => {
  const app = harness();
  const source = "and a system can fail either way while\nlooking perfectly healthy in the other\n系统可能因其中任何一点而失效，\n但在另一个";
  const text = sample.replace("Hello\n你好", source);
  await app.send("import", {text});
  const box = app.elements[0];
  assert.equal(box.textContent, "and a system can fail either way while looking perfectly healthy in the other\n系统可能因其中任何一点而失效，但在另一个");
  assert.equal(box.style.left, "340px");
  assert.equal(app.video.tracks[0].cues[0].startTime, 1);
  assert.equal(app.video.tracks[0].cues[0].endTime, 3);
  assert.equal(app.video.tracks[0].cues[0].getCueAsHTML().textContent, source);
  const key = (await app.send("status")).context.key;
  assert.equal(app.storage[key].text, text);
  const reopened = harness(app.storage);
  await reopened.send("status");
  assert.equal(reopened.elements[0].textContent, box.textContent);
  const mixed = "使用 API\n请求接口\nEnglish\n123\nNext\nEnglish\n你好\n世界";
  await app.send("import", {text: sample.replace("Hello\n你好", mixed)});
  assert.equal(box.textContent, "使用 API\n请求接口\nEnglish\n123\nNext English\n你好世界");
});


test("position reaches the bottom edge at 100 percent and persists, but rejects 101", async () => {
  const app = harness();
  await app.send("import", {text: sample});
  assert.equal((await app.send("subtitle_style", {style: {font_size: 24, position: 100}})).ok, true);
  assert.equal(app.elements[0].style.top, "290px");
  assert.equal(app.video.tracks[0].cues[0].line, 100);
  const reopened = harness(app.storage);
  assert.equal((await reopened.send("status")).subtitle_style.position, 100);
  assert.equal(reopened.elements[0].style.top, "290px");
  assert.equal((await app.send("subtitle_style", {style: {font_size: 24, position: 101}})).ok, false);
  assert.equal(app.elements[0].style.top, "290px");
});
