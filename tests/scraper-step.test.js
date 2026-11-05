"use strict";
// Covers the clean-host scraper step (scrape-server.js): auth header, shape
// validation, fallback order, and the server parser mirror. No network.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadWorker, makeKV } = require("./helpers/worker-test-env");
const { pageHtml } = require("./helpers/page-html");
const { parsePlaylistPage } = require("../scrape-server.js");
const worker = loadWorker();

const PID = "EEEEEEEEEEEEEEEEEEEEEE";
const T1 = "1111111111111111111111";
const T2 = "2222222222222222222222";
const SCRAPER = "https://scraper.test";

function req(p, body) {
  return new Request("https://test.invalid" + p, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const scraperTracks = [
  { id: T1, title: "Torn", artists: ["Natalie Imbruglia"] },
  { id: T2, title: "Creep", artists: ["Radiohead"] },
];

async function addVia(env, fetchImpl, pid) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    let res = await worker.fetch(req("/api/rooms"), env);
    const { code } = await res.json();
    res = await worker.fetch(
      req(`/api/rooms/${code}/playlists`, {
        playlistUrl: `https://open.spotify.com/playlist/${pid}`,
      }),
      env
    );
    return { status: res.status, body: await res.json(), code };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("scraper step: uses clean-host JSON with bearer secret", async () => {
  let seenAuth = null;
  const env = { ROOMS: makeKV(), SCRAPER_URL: SCRAPER, SCRAPER_SECRET: "s3cr3t" };
  const { status, body } = await addVia(env, async (url, opts) => {
    if (String(url).startsWith(SCRAPER)) {
      seenAuth = opts && opts.headers && opts.headers.Authorization;
      return Response.json({ playlistId: PID, name: "Host Mix", owner: null, tracks: scraperTracks });
    }
    throw new Error("curl must not run when scraper answers");
  }, PID);
  assert.equal(status, 200);
  assert.equal(body.via, "scraper");
  assert.equal(body.trackCount, 2);
  assert.equal(seenAuth, "Bearer s3cr3t");
});

test("scraper step: bad shape falls through to curl scrape", async () => {
  const env = { ROOMS: makeKV(), SCRAPER_URL: SCRAPER, SCRAPER_SECRET: "s3cr3t" };
  const html = pageHtml("Curl Mix", [{ id: T1, title: "Torn", artists: ["Natalie Imbruglia"] }]);
  const { status, body } = await addVia(env, async (url) => {
    if (String(url).startsWith(SCRAPER)) return Response.json({ tracks: "nope" });
    return new Response(html, { status: 200 });
  }, PID);
  assert.equal(status, 200);
  assert.equal(body.via, "scrape");
});

test("scraper step: scraper down plus empty curl plus no browser is 403", async () => {
  const env = { ROOMS: makeKV(), SCRAPER_URL: SCRAPER };
  const { status, body } = await addVia(env, async (url) => {
    if (String(url).startsWith(SCRAPER)) throw new Error("host down");
    return new Response("<html><head><title>Spotify</title></head><body></body></html>", { status: 200 });
  }, PID);
  assert.equal(status, 403);
  assert.equal(body.code, "NOT_READABLE");
});

test("scraper step: second room served from page cache", async () => {
  const env = { ROOMS: makeKV(), SCRAPER_URL: SCRAPER };
  const stub = async (url) => {
    if (String(url).startsWith(SCRAPER)) {
      return Response.json({ playlistId: PID, name: "Cached Mix", owner: null, tracks: scraperTracks });
    }
    throw new Error("no direct fetch expected");
  };
  const first = await addVia(env, stub, PID);
  assert.equal(first.body.via, "scraper");
  globalThis.fetch = async () => { throw new Error("network down"); };
  try {
    let res = await worker.fetch(req("/api/rooms"), env);
    const { code } = await res.json();
    res = await worker.fetch(
      req(`/api/rooms/${code}/playlists`, {
        playlistUrl: `https://open.spotify.com/playlist/${PID}`,
      }),
      env
    );
    assert.equal(res.status, 200);
    assert.equal((await res.json()).via, "cache");
  } finally {
    globalThis.fetch = undefined;
  }
});

test("scrape-server parser mirror: parses record-shaped HTML", () => {
  const html = pageHtml("Mirror Mix", [
    { id: T1, title: "Torn", artists: ["Natalie Imbruglia"] },
    { id: T2, title: "Creep", artists: ["Radiohead"] },
  ]);
  const parsed = parsePlaylistPage(html);
  assert.equal(parsed.name, "Mirror Mix");
  assert.equal(parsed.tracks.length, 2);
  assert.deepEqual(parsed.tracks[0].artists, ["Natalie Imbruglia"]);
});
