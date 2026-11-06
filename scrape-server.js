"use strict";
// Karaoke scrape microservice: runs on a host whose egress Spotify serves
// full playlist pages to (home network, clean VPS). The Cloudflare Worker
// calls GET /scrape?pid=<22-char> instead of fetching Spotify itself.
//
// Zero deps, Node 18+. Usage:
//   SCRAPER_SECRET=$(openssl rand -hex 32) PORT=8787 node scrape-server.js
// Expose it (example): cloudflared tunnel --url http://localhost:8787
// Then on the worker: set SCRAPER_URL var, `wrangler secret put SCRAPER_SECRET`.
const http = require("node:http");

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const SECRET = process.env.SCRAPER_SECRET || "";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// Mirror of scrapePlaylistPage() in worker.js — keep in sync (same regex,
// same title rule, same 600-track cap). Returns { name, tracks }.
/* Rail headings that mark non-playlist content below the tracklist. The rail
 * title varies ("Recommended", "Fans also like", ...), so cut at the earliest
 * heading-like match. Track titles can't false-positive: the pattern requires
 * the words to span a whole element's text. Mirrored in worker.js. */
var RAIL_HEADINGS = ["recommended", "fans also like", "more of what you like",
  "you might also like", "you may also like"];
function cutRail(html) {
  var best = -1;
  for (var i = 0; i < RAIL_HEADINGS.length; i++) {
    var m = html.match(new RegExp(">[^<>]*" + RAIL_HEADINGS[i] + "[^<>]*<", "i"));
    if (m && (best === -1 || m.index < best)) best = m.index;
  }
  return best > 0 ? html.slice(0, best) : html;
}

/* Playlist total as printed in the page header ("Playlist · 278 songs").
 * Only a count with "playlist" nearby qualifies. Mirrored in worker.js. */
function extractTotal(html) {
  var m = html.match(/playlist[^<>]{0,80}?(\d[\d,]*)\s+songs?/i);
  if (!m) return null;
  var n = parseInt(m[1].replace(/,/g, ""), 10);
  return n > 0 ? n : null;
}

function parsePlaylistPage(html) {
  var nameM = html.match(/<title>([^<]*?)(?: - playlist by .*?)?(?: \| Spotify)?<\/title>/i);
  var name = nameM ? nameM[1].trim() : null;
  var body = cutRail(html);
  var tracks = [], seen = {};
  var re = /<a[^>]+href="\/track\/([A-Za-z0-9]{22})"[^>]*>([^<]+)<\/a>\s*(?:<[^>]*>)*<a[^>]+href="\/artist\/[A-Za-z0-9]{22}"[^>]*>([^<]+)<\/a>/g;
  var m, guard = 0;
  while ((m = re.exec(body)) && guard < 600) {
    guard++;
    var tid = m[1], title = m[2].trim(), artist = m[3].trim();
    if (!title || !artist || seen[tid]) continue;
    seen[tid] = true;
    var artists = [artist];
    var rest = body.slice(m.index + m[0].length, m.index + m[0].length + 300);
    var m2 = rest.match(/^[^<]*<a[^>]+href="\/artist\/[A-Za-z0-9]{22}"[^>]*>([^<]+)<\/a>/);
    if (m2 && m2[1].trim() && m2[1].trim() !== artist) artists.push(m2[1].trim());
    tracks.push({ id: tid, isrc: null, title: title, artists: artists,
      popularity: 0, durationMs: 0, image: null, explicit: false, via: "scraper" });
  }
  return { name: name, tracks: tracks, metaTotal: extractTotal(html) };
}

async function fetchPlaylistPage(pid) {
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, 20000);
  try {
    var r = await fetch("https://open.spotify.com/playlist/" + pid, {
      signal: ctrl.signal,
      headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
    });
    if (!r.ok) {
      var e = new Error("Playlist page returned HTTP " + r.status);
      e.status = r.status; throw e;
    }
    return await r.text();
  } finally { clearTimeout(timer); }
}

function send(res, status, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function start() {
  if (!SECRET) {
    console.error("scrape-server: refusing to start without SCRAPER_SECRET (this is an open proxy otherwise).");
    process.exit(1);
  }
  var server = http.createServer(function (req, res) {
    var u;
    try { u = new URL(req.url || "/", "http://x"); }
    catch (e) { return send(res, 400, { code: "BAD_URL", message: "Bad URL." }); }
    if (req.method === "GET" && u.pathname === "/") {
      return send(res, 200, { ok: true, service: "karaoke-scraper" });
    }
    if (req.method !== "GET" || u.pathname !== "/scrape") {
      return send(res, 404, { code: "NOT_FOUND", message: "Unknown endpoint." });
    }
    var auth = req.headers.authorization || "";
    if (auth !== "Bearer " + SECRET) {
      return send(res, 401, { code: "BAD_SECRET", message: "Missing or wrong bearer secret." });
    }
    var pid = u.searchParams.get("pid") || "";
    if (!/^[A-Za-z0-9]{22}$/.test(pid)) {
      return send(res, 400, { code: "INVALID_PID", message: "Pass ?pid=<22-char playlist id>." });
    }
    fetchPlaylistPage(pid).then(function (html) {
      var parsed = parsePlaylistPage(html);
      if (!parsed.tracks.length) {
        return send(res, 502, { code: "NO_TRACKS", message: "Page had zero parseable tracks (bot shell?)." });
      }
      send(res, 200, { playlistId: pid, name: parsed.name, owner: null,
        trackCount: parsed.tracks.length, tracks: parsed.tracks, metaTotal: parsed.metaTotal, fetchedAt: Date.now() });
    }).catch(function (e) {
      send(res, e.status === 404 ? 404 : 502,
        { code: "FETCH_FAILED", message: e.message || "Playlist fetch failed." });
    });
  });
  server.listen(PORT, HOST, function () {
    console.log("scrape-server listening on " + HOST + ":" + PORT);
  });
  return server;
}

if (require.main === module) { start(); }
else { module.exports = { parsePlaylistPage: parsePlaylistPage }; }
