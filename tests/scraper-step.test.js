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

test("total: header count extracted, track titles with numbers ignored", () => {
  const html = `<html><head><title>Mirror Mix - playlist by host | Spotify</title></head><body>` +
    `<div class="header">Playlist · 278 songs</div>` +
    pageHtml("Mirror Mix", [
      { id: T1, title: "10 Songs I Love", artists: ["Counters"] },
      { id: T2, title: "Creep", artists: ["Radiohead"] },
    ]).split("<body>")[1];
  const parsed = parsePlaylistPage(html);
  assert.equal(parsed.metaTotal, 278);
  assert.equal(parsed.tracks.length, 2);
});

test("worker: shortfall against header total is flagged partial", async () => {
  const { scrapePlaylistPage } = worker;
  const realFetch = globalThis.fetch;
  const html = `<html><head><title>Big List - playlist by host | Spotify</title></head><body>` +
    `<div>Playlist · 278 songs</div>` +
    pageHtml("Big List", [{ id: T1, title: "Torn", artists: ["Natalie Imbruglia"] }]).split("<body>")[1];
  globalThis.fetch = async () => new Response(html, { status: 200 });
  try {
    const parsed = await scrapePlaylistPage("AAAAAAAAAAAAAAAAAAAAAA");
    assert.equal(parsed.tracks.length, 1);
    assert.equal(parsed.metaTotal, 278);

    const env = { ROOMS: makeKV() };
    globalThis.fetch = async () => new Response(html, { status: 200 });
    let res = await worker.fetch(req("/api/rooms"), env);
    const { code } = await res.json();
    res = await worker.fetch(
      req(`/api/rooms/${code}/playlists`, {
        playlistUrl: "https://open.spotify.com/playlist/AAAAAAAAAAAAAAAAAAAAAA",
      }),
      env
    );
    assert.equal(res.status, 200);
    const added = await res.json();
    assert.equal(added.trackCount, 1);
    assert.equal(added.metaTotal, 278);
    assert.equal(added.partial, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("worker: no header count means full read, no partial flag", async () => {
  const env = { ROOMS: makeKV() };
  const html = pageHtml("Small Mix", [{ id: T1, title: "Torn", artists: ["Natalie Imbruglia"] }]);
  const added = await addVia(env, async () => new Response(html, { status: 200 }), PID);
  assert.equal(added.status, 200);
  assert.equal(added.body.metaTotal, 1);
  assert.equal(added.body.partial, false);
});

test("sampled shell: rail rows dropped, shortfall flagged partial", async () => {
  // Shape of the real incident: 10 playlist rows, then a 6-row rail under a
  // non-"Recommended" heading, with a true header total of 278.
  const row = (id, title) =>
    `<a href="/track/${id}">${title}</a>` +
    `<a href="/artist/AAAAAAAAAAAAAAAAAAAAAA">Someone</a>`;
  const realIds = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "A"].map((c) => c.repeat(22));
  const railIds = ["B", "C", "D", "E", "F", "0"].map((c) => c.repeat(22));
  const html = `<html><head><title>Sampled Mix - playlist by host | Spotify</title></head><body>` +
    `<div class="header">Playlist · 278 songs</div>` +
    realIds.map((id, i) => row(id, `Real Song ${i}`)).join("") +
    `<h2>Fans also like</h2>` +
    railIds.map((id, i) => row(id, `Rail Junk ${i}`)).join("") +
    `</body></html>`;

  // Server mirror drops the rail and reports the header total.
  const serverParsed = parsePlaylistPage(html);
  assert.equal(serverParsed.tracks.length, 10);
  assert.equal(serverParsed.metaTotal, 278);
  assert.ok(serverParsed.tracks.every((t) => t.title.startsWith("Real Song")));

  // Worker path: same parse through the room add flow.
  globalThis.fetch = async () => new Response(html, { status: 200 });
  try {
    const workerParsed = await worker.scrapePlaylistPage("FFFFFFFFFFFFFFFFFFFFFF");
    assert.equal(workerParsed.tracks.length, 10);
    assert.equal(workerParsed.metaTotal, 278);
  } finally {
    globalThis.fetch = undefined;
  }
  const env = { ROOMS: makeKV() };
  const added = await addVia(env, async () => new Response(html, { status: 200 }), "FFFFFFFFFFFFFFFFFFFFFF");
  assert.equal(added.status, 200);
  assert.equal(added.body.via, "scrape");
  assert.equal(added.body.trackCount, 10);
  assert.equal(added.body.metaTotal, 278);
  assert.equal(added.body.partial, true);
});
