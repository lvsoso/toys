"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

test("backend proxy fixes its origin and rejects arbitrary paths and external senders", async () => {
  let receive;
  const calls = [];
  const context = {chrome: {runtime: {id: "fixture", onMessage: {addListener(handler) { receive = handler; }}}},
    AbortSignal, fetch: async (url, options) => {
      calls.push({url, options});
      return {ok: true, json: async () => ({state: "queued"})};
    }};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../background.js"), "utf8"), context);
  const send = (message) => new Promise((resolve) => receive({source: "myuds:backend", ...message}, {id: "fixture"}, resolve));
  assert.equal((await send({operation: "submit", payload: {cues: []}})).ok, true);
  assert.equal(calls[0].url, "http://127.0.0.1:8765/translations");
  assert.equal(calls[0].options.headers["X-MyUdemy-Extension"], "fixture");
  assert.equal((await send({operation: "status", job_id: "../../evil"})).ok, false);
  assert.equal(receive({source: "myuds:backend"}, {id: "other"}, () => {}), false);
  assert.equal(calls.length, 1);
});
