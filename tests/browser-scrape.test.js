"use strict";
// Covers the XHR-intercept scrape path's pure pieces + the KV page cache.
// No network, no browser binary: env.BROWSER is unset so the browser step
// is skipped by construction; the curl scrape is stubbed via global fetch.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadWorker, makeKV } = require("./helpers/worker-test-env");
const worker = loadWorker();
const { extractTracksFromJson } = worker;

const T1 = "1111111111111111111111";
const T2 = "2222222222222222222222";
const T3 = "3333333333333333333333";

test("extractTracksFromJson: api-shaped items envelope", () => {
  const payload = {
    items: [
      { track: { id: T1, name: "Torn", artists: [{ name: "Natalie Imbruglia" }] } },
      { track: { id: T2, name: "Creep", artists: [{ name: "Radiohead" }] } },
    ],
  };
  const got = extractTracksFromJson(payload);
  assert.equal(got.length, 2);
  assert.equal(got[0].title, "Torn");
  assert.deepEqual(got[0].artists, ["Natalie Imbruglia"]);
  assert.equal(got[0].via, "browser");
});

test("extractTracksFromJson: nested envelope, largest candidate wins", () => {
  const payload = {
    data: { playlist: { items: [
      { item: { id: T1, name: "A", artists: ["x"] } },
      { item: { id: T2, name: "B", artists: ["y"] } },
      { item: { id: T3, name: "C", artists: ["z"] } },
    ] } },
    sidebar: { items: [{ item: { id: T1, name: "A", artists: ["x"] } }] },
  };
  assert.equal(extractTracksFromJson(payload).length, 3);
});

test("extractTracksFromJson: bare artist lists never false-positive", () => {
  assert.deepEqual(extractTracksFromJson({ items: [
    { id: T1, name: "Queen" },
    { id: T2, name: "Oasis" },
  ] }), []);
  assert.deepEqual(extractTracksFromJson({ foo: "bar" }), []);
});

test("extractTracksFromJson: dedups by track id", () => {
  const entry = { track: { id: T1, name: "Torn", artists: [{ name: "Natalie Imbruglia" }] } };
  assert.equal(extractTracksFromJson({ items: [entry, entry] }).length, 1);
});

// Fake record page: consecutive /track/ + /artist/ anchors,
// exactly what worker scrapePlaylistPage()'s regex consumes.
function pageHtml(name, tracks) {
  const rows = tracks
    .map((t) => `<a href="/track/${t.id}">${t.title}</a>` +
      `<a href="/artist/AAAAAAAAAAAAAAAAAAAAAA">${t.artists[0]}</a>`)
    .join("");
  return `<html><head><title>${name} - playlist by host | Spotify</title></head>` +
    `<body>${rows}</body></html>`;
}

test("KV page cache: second room reuses render without refetch", async () => {
  const PID = "DDDDDDDDDDDDDDDDDDDDDD";
  const html = pageHtml("Cached Mix", [
    { id: T1, title: "Torn", artists: ["Natalie Imbruglia"] },
  ]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(html, { status: 200 });
  const env = { ROOMS: makeKV() };
  const req = (method, p, body) => new Request("https://test.invalid" + p, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  try {
    let res = await worker.fetch(req("POST", "/api/rooms"), env);
    const room1 = (await res.json()).code;
    res = await worker.fetch(
      req("POST", `/api/rooms/${room1}/playlists`, {
        playlistUrl: `https://open.spotify.com/playlist/${PID}`,
      }),
      env
    );
    assert.equal(res.status, 200);

    // Network dies; the page cache must carry the second room.
    globalThis.fetch = async () => { throw new Error("network down"); };
    res = await worker.fetch(req("POST", "/api/rooms"), env);
    const room2 = (await res.json()).code;
    res = await worker.fetch(
      req("POST", `/api/rooms/${room2}/playlists`, {
        playlistUrl: `https://open.spotify.com/playlist/${PID}`,
      }),
      env
    );
    assert.equal(res.status, 200);
    const added = await res.json();
    assert.equal(added.via, "cache");
    assert.equal(added.trackCount, 1);
    assert.equal(added.name, "Cached Mix");
  } finally {
    globalThis.fetch = realFetch;
  }
});
