"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

test("GraphQL observer preserves responses and handles consumed Request bodies", async () => {
  let receive;
  const replies = [];
  const window = {async fetch(input) {
    if (input instanceof Request) await input.text();
    return new Response(JSON.stringify({data: {lecture: {asset: {captions: [
      {language: "en", videoLabel: "English", url: "https://a.udemycdn.com/sub.vtt"},
    ]}}}}));
  }, addEventListener(type, handler) { receive = handler; }, postMessage(data) { replies.push(data); }};
  const context = vm.createContext({window, location: {origin: "https://www.udemy.com", href: "https://www.udemy.com/course/test"}, Request, URL});
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../bridge.js"), "utf8"), context);
  const request = new Request("https://www.udemy.com/api/2024-01/graphql", {method: "POST", body: JSON.stringify({variables: {id: "123"}})});
  const response = await window.fetch(request);
  assert.equal((await response.json()).data.lecture.asset.captions[0].language, "en");
  await new Promise((resolve) => setTimeout(resolve, 30));
  receive({source: window, origin: "https://evil.test", data: {type: "myuds:captions:request", request_id: "bad", lecture_id: "123"}});
  assert.equal(replies.length, 0);
  receive({source: window, origin: "https://www.udemy.com", data: {type: "myuds:captions:request", request_id: "ok", lecture_id: "123"}});
  assert.equal(replies[0].captions[0].label, "English");
  assert.equal(replies[0].captions.length, 1);
});
