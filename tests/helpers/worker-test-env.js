"use strict";
// Shared test harness: loads the real Cloudflare Worker + an in-memory KV.
// worker.js is ESM (`export default`, main in wrangler.toml); under this repo's
// CommonJS test env we load its source with that single declarator rewritten.
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

function loadWorker() {
  const file = path.join(__dirname, "..", "..", "worker.js");
  const src = fs.readFileSync(file, "utf8").replace("export default", "module.exports =");
  const m = new Module("worker-under-test", module);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(src, file);
  return m.exports;
}

// In-memory stand-in for the env.ROOMS KV binding.
function makeKV() {
  const m = new Map();
  return {
    async put(k, v) { m.set(k, String(v)); },
    async get(k, opts) {
      const v = m.has(k) ? m.get(k) : null;
      if (v === null || v === undefined) return null;
      if (opts && opts.type === "json") return JSON.parse(v);
      return v;
    },
    async delete(k) { m.delete(k); },
  };
}

module.exports = { loadWorker, makeKV };
