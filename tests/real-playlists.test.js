"use strict";
// Real-playlist replay test: create room -> add 2 real karaoke-night playlists
// -> find the similar songs. Hermetic: serves recorded page bytes
// (tests/fixtures/page-<pid>.html) through the REAL worker scrape path.
// No fixtures yet? Run from a home network: npm run record-fixtures
// (then paste its report back so pinned overlap assertions can be added).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadWorker, makeKV } = require("./helpers/worker-test-env");
const { matchPlaylists } = require("../app.js");

const PLAYLISTS = [
  {
    pid: "2EQ7KfixtMkBJ8knfYV4Xf",
    url: "https://open.spotify.com/playlist/2EQ7KfixtMkBJ8knfYV4Xf?si=CnKAo20vRxCNY6B971YZA",
  },
  {
    pid: "5wndxpncEMNYxGelrpTJNi",
    url: "https://open.spotify.com/playlist/5wndxpncEMNYxGelrpTJNi?si=h974nDDcRTiWypiegFh1IRQ",
  },
];

const fixturesReady = PLAYLISTS.every(
  (p) => p.url && fs.existsSync(path.join(__dirname, "fixtures", `page-${p.pid}.html`))
);

function stubRecordedPages() {
  const pages = {};
  for (const p of PLAYLISTS) {
    pages[p.pid] = fs.readFileSync(
      path.join(__dirname, "fixtures", `page-${p.pid}.html`), "utf8"
    );
  }
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const m = String(url).match(/open\.spotify\.com\/playlist\/([A-Za-z0-9]{22})/);
    if (m && pages[m[1]]) {
      return new Response(pages[m[1]], {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }
    throw new Error("unexpected fetch in test (no network): " + url);
  };
  return () => { globalThis.fetch = realFetch; };
}

function req(method, p, body) {
  return new Request("https://test.invalid" + p, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

test(
  "real playlists: create room, add 2 link shares, find similar songs",
  { skip: !fixturesReady && "fixtures missing -- run: npm run record-fixtures" },
  async (t) => {
    const worker = loadWorker();
    // No SPOTIFY_CLIENT_ID -> worker takes the pure scrape path, same as the
    // room flow for public links shared in chat apps.
    const env = { ROOMS: makeKV() };
    const restore = stubRecordedPages();
    try {
      let res = await worker.fetch(req("POST", "/api/rooms"), env);
      assert.equal(res.status, 200);
      const { code } = await res.json();

      for (const p of PLAYLISTS) {
        res = await worker.fetch(
          req("POST", `/api/rooms/${code}/playlists`, { playlistUrl: p.url }),
          env
        );
        assert.equal(res.status, 200, "adding playlist " + p.pid);
        const added = await res.json();
        assert.equal(added.playlistId, p.pid);
      }

      res = await worker.fetch(req("GET", `/api/rooms/${code}/results`), env);
      assert.equal(res.status, 200);
      const { snapshots } = await res.json();
      assert.equal(snapshots.length, 2);
      for (const s of snapshots) {
        assert.ok(s.tracks.length > 0, `empty track list for ${s.playlistId}`);
        assert.ok(s.name, `missing playlist name for ${s.playlistId}`);
      }

      const songs = matchPlaylists(snapshots.map((s) => s.tracks));
      assert.ok(songs.length > 0);

      // Ranking invariant: sorted by overlap desc.
      for (let i = 1; i < songs.length; i++) {
        assert.ok(
          songs[i - 1].overlap >= songs[i].overlap,
          "results not ranked by overlap"
        );
      }

      // Cross-check: full-overlap set from matchPlaylists must equal an
      // independent track-id intersection over the stored snapshots.
      const idSets = snapshots.map((s) => new Set(s.tracks.map((x) => x.id)));
      const expectedFull = [...idSets[0]].filter((id) => idSets[1].has(id));
      const actualFull = songs.filter((s) => s.overlap === 2);
      const actualIds = new Set(
        actualFull
          .map((g) => String(g.key).replace(/^id:/, ""))
          .filter((id) => /^[A-Za-z0-9]{22}$/.test(id))
      );
      assert.deepEqual(actualIds, new Set(expectedFull), "full-overlap song set mismatch");

      // Pinned spot-checks (fixture snapshot 2026-11-05): karaoke staples
      // present in both real playlists. Re-record fixtures to refresh.
      const byTitle = new Map(songs.map((s) => [s.title, s]));
      for (const t of ["Truly Madly Deeply", "A Thousand Miles", "Irreplaceable"]) {
        assert.ok(byTitle.has(t), `expected "${t}" in results`);
        assert.equal(byTitle.get(t).overlap, 2, `"${t}" should be in both playlists`);
      }

      const top = songs.slice(0, 5).map((s) => `${s.title} -- ${(s.artists || []).join(", ")} (${s.overlap}/2)`);
      t.diagnostic("top overlaps:\n" + top.join("\n"));
      t.diagnostic(`full 2/2: ${actualFull.length}, solo 1/2: ${songs.filter((s) => s.overlap === 1).length}`);
    } finally {
      restore();
    }
  }
);
