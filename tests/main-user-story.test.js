"use strict";
// Main user story: create room -> add 3 Spotify playlists -> find the common song.
// Hermetic: Spotify page scrapes are stubbed via global fetch; no network, no KV.
// Run with: npm test
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadWorker, makeKV } = require("./helpers/worker-test-env");
const { matchPlaylists } = require("../app.js");

// 22-char playlist ids (must satisfy worker ID_RE).
const PL_A = "AAAAAAAAAAAAAAAAAAAAAA";
const PL_B = "BBBBBBBBBBBBBBBBBBBBBB";
const PL_C = "CCCCCCCCCCCCCCCCCCCCCC";

// 22-char track ids. The COMMON song shares one id across all three
// playlists, mirroring Spotify (same recording = same track id -> Tier-1).
const T_COMMON = "1111111111111111111111";
const T_AB = "2222222222222222222222";
const T_A_ONLY = "3333333333333333333333";
const T_B_ONLY = "4444444444444444444444";
const T_C_ONLY1 = "5555555555555555555555";
const T_C_ONLY2 = "6666666666666666666666";
const ARTIST_ID = "AAAAAAAAAAAAAAAAAAAAAA";

const PLAYLISTS = {
  [PL_A]: [
    { id: T_COMMON, title: "Bohemian Rhapsody", artists: ["Queen"] },
    { id: T_AB, title: "Imagine", artists: ["John Lennon"] },
    { id: T_A_ONLY, title: "A Sky Full of Stars", artists: ["Coldplay"] },
  ],
  [PL_B]: [
    { id: T_COMMON, title: "Bohemian Rhapsody", artists: ["Queen"] },
    { id: T_AB, title: "Imagine", artists: ["John Lennon"] },
    { id: T_B_ONLY, title: "Blinding Lights", artists: ["The Weeknd"] },
  ],
  [PL_C]: [
    { id: T_COMMON, title: "Bohemian Rhapsody", artists: ["Queen"] },
    { id: T_C_ONLY1, title: "Levitating", artists: ["Dua Lipa"] },
    { id: T_C_ONLY2, title: "As It Was", artists: ["Harry Styles"] },
  ],
};


// Fake public playlist page: consecutive /track/ + /artist/ anchors,
// exactly what worker scrapePlaylistPage()'s regex consumes.
function pageHtml(name, tracks) {
  const rows = tracks
    .map((t) => `<a href="/track/${t.id}">${t.title}</a>` +
      `<a href="/artist/${ARTIST_ID}">${t.artists[0]}</a>`)
    .join("");
  return `<html><head><title>${name} - playlist by host | Spotify</title></head>` +
    `<body>${rows}</body></html>`;
}

function stubSpotifyPages() {
  const pages = {
    [PL_A]: pageHtml("KTV Night A", PLAYLISTS[PL_A]),
    [PL_B]: pageHtml("KTV Night B", PLAYLISTS[PL_B]),
    [PL_C]: pageHtml("KTV Night C", PLAYLISTS[PL_C]),
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const m = u.match(/open\.spotify\.com\/playlist\/([A-Za-z0-9]{22})/);
    if (m && pages[m[1]]) {
      return new Response(pages[m[1]], {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }
    throw new Error("unexpected fetch in test (no network): " + u);
  };
  return () => { globalThis.fetch = realFetch; };
}

function req(method, path, body) {
  return new Request("https://test.invalid" + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

test("main user story: create room, add 3 playlists, find the common song", async () => {
  const worker = loadWorker();
  // No SPOTIFY_CLIENT_ID -> worker skips API enrichment; scrape stub stands alone.
  const env = { ROOMS: makeKV() };
  const restore = stubSpotifyPages();
  try {
    // 1) Create room.
    let res = await worker.fetch(req("POST", "/api/rooms"), env);
    assert.equal(res.status, 200);
    const created = await res.json();
    assert.match(created.code, /^KTV-/);
    const code = created.code;

    // 2) Input 3 Spotify playlists.
    for (const pid of [PL_A, PL_B, PL_C]) {
      res = await worker.fetch(
        req("POST", `/api/rooms/${code}/playlists`, {
          playlistUrl: `https://open.spotify.com/playlist/${pid}`,
        }),
        env
      );
      assert.equal(res.status, 200, "adding playlist " + pid);
      const added = await res.json();
      assert.equal(added.playlistId, pid);
      assert.ok(added.trackCount >= 3);
    }

    // Room poll sees all three participants.
    res = await worker.fetch(req("GET", `/api/rooms/${code}`), env);
    assert.equal(res.status, 200);
    const room = await res.json();
    assert.equal(room.participants.length, 3);

    // 3) Find the similar song.
    res = await worker.fetch(req("GET", `/api/rooms/${code}/results`), env);
    assert.equal(res.status, 200);
    const { snapshots } = await res.json();
    assert.equal(snapshots.length, 3);

    const songs = matchPlaylists(snapshots.map((s) => s.tracks));

    // Exactly one song is in all 3 playlists, ranked first.
    const full = songs.filter((s) => s.overlap === 3);
    assert.equal(full.length, 1);
    assert.equal(full[0].title, "Bohemian Rhapsody");
    assert.deepEqual(full[0].artists, ["Queen"]);
    assert.equal(songs[0].title, "Bohemian Rhapsody");
    assert.equal(songs[0].overlap, 3);

    // Partial overlap (2/3) is detected too.
    const partial = songs.filter((s) => s.overlap === 2);
    assert.equal(partial.length, 1);
    assert.equal(partial[0].title, "Imagine");
  } finally {
    restore();
  }
});
