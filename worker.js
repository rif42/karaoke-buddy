/* Karaoke Consensus — Cloudflare Worker (vanilla JS, no deps).
 * FETCH MODEL v1.7 (scrape-first): public playlist pages server-render full
 * track lists (no auth) -> scrapePlaylistPage() is PRIMARY for public lists.
 * Web API retained for metadata + owned-list fast path. Per-guest OAuth kept
 * ONLY for private playlists. Room rendezvous in KV (TTL 4h).
 * Free-tier budget: ~7 req/session vs 100k/day; ~6 KV writes/room vs 1k/day.
 *
 * Bindings (wrangler.toml): KV namespace `ROOMS`.
 * Secrets: `wrangler secret put SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`
 *   (metadata/fast-path only — public flow works without them).
 */

var MAX_PLAYLISTS = 5; // must match app.js
var ROOM_TTL = 14400; // 4h
var TRACK_CAP = 500;
var ID_RE = /^[A-Za-z0-9]{22}$/;

function cors(extra) {
  return Object.assign({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  }, extra || {});
}
function json(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: cors() });
}
function err(code, message, status) { return json({ code: code, message: message }, status || 400); }
function roomCode() {
  var chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  var a = new Uint8Array(4), s = "KTV-";
  crypto.getRandomValues(a);
  for (var i = 0; i < 4; i++) s += chars[a[i] % chars.length];
  return s;
}
function extractId(url) {
  var m = String(url || "").trim().match(/(?:open\.spotify\.com\/playlist\/|spotify:playlist:)([A-Za-z0-9]{22})/);
  return m ? m[1] : null;
}

/* ---- Plan B: per-guest user tokens (Feb-2026 ownership rule).
 * App tokens can't read others' playlists (403). Each guest OAuths once
 * (Authorization Code + PKCE would need a backend exchange — here the Worker
 * IS the backend, so plain Authorization Code with client_secret is fine);
 * the Worker fetches THAT guest's playlist with THEIR token (ownership OK).
 * Scopes: playlist-read-private (covers public + private + collaborative).
 */
function b64url(bytes) {
  var s = btoa(String.fromCharCode.apply(null, bytes));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function newState() {
  var a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return b64url(a);
}
// Bearer call with an EXPLICIT user token (no app-token cache involved).
async function userSpotify(path, userToken) {
  var r = await fetch("https://api.spotify.com" + path, { headers: { "Authorization": "Bearer " + userToken } });
  if (r.status === 401) {
    var e = new Error("Guest Spotify session expired. Ask them to tap Connect again.");
    e.code = "GUEST_TOKEN_EXPIRED"; e.spotifyStatus = 401; e.path = path; throw e;
  }
  if (r.status === 429) {
    var ra = parseInt(r.headers.get("Retry-After") || "5", 10);
    var e2 = new Error("Spotify rate-limited, retry in " + ra + "s.");
    e2.code = "RATE_LIMITED"; e2.spotifyStatus = 429; e2.path = path; throw e2;
  }
  if (r.status === 403) {
    var e3 = new Error("Spotify refused this playlist for this guest (403). They must own/collaborate on it, or pick another.");
    e3.code = "NOT_THEIRS"; e3.spotifyStatus = 403; e3.path = path; throw e3;
  }
  if (r.status === 404) {
    var e4 = new Error("Playlist not found (404). Check the link.");
    e4.code = "NOT_FOUND"; e4.spotifyStatus = 404; e4.path = path; throw e4;
  }
  if (!r.ok) {
    var e5 = new Error("Spotify error " + r.status + " on " + path);
    e5.code = "SPOTIFY_ERROR"; e5.spotifyStatus = r.status; e5.path = path; throw e5;
  }
  return r.json();
}
// Same dual-shape page logic as getTracksPage, but with a user bearer.
async function getUserTracksPage(pid, offset, fields, userToken) {
  var itemsPath = "/v1/playlists/" + pid + "/items?limit=100&offset=" + offset + "&fields=" + encodeURIComponent(fields);
  var tracksPath = "/v1/playlists/" + pid + "/tracks?limit=100&offset=" + offset + "&fields=" + encodeURIComponent(fields);
  var lastErr = null;
  try {
    var a = await userSpotify(itemsPath, userToken);
    return { json: a, endpointUsed: "items" };
  } catch (e) { lastErr = e; }
  try {
    var b = await userSpotify(tracksPath, userToken);
    return { json: b, endpointUsed: "tracks" };
  } catch (e2) {
    e2.fallbackFrom = lastErr ? { path: lastErr.path, spotifyStatus: lastErr.spotifyStatus } : null;
    throw e2;
  }
}
// Guest's OWN playlists, for the picker (public + private + collaborative).
async function listUserPlaylists(userToken) {
  var out = [], url = "/v1/me/playlists?limit=50";
  var guard = 0;
  while (url && guard < 4) {
    guard++;
    var j = await userSpotify(url, userToken);
    (j.items || []).forEach(function (p) {
      if (!p || !p.id) return;
      out.push({ id: p.id, name: p.name,
        image: (p.images && p.images[1] && p.images[1].url) || (p.images && p.images[0] && p.images[0].url) || null,
        trackCount: (p.tracks && p.tracks.total) || 0,
        owner: (p.owner && (p.owner.display_name || p.owner.id)) || null });
    });
    url = j.next ? j.next.replace("https://api.spotify.com", "") : null;
  }
  return out;
}
var tokenCache = { token: null, exp: 0 };
async function appToken(env) {
  if (tokenCache.token && Date.now() < tokenCache.exp) return tokenCache.token;
  var basic = btoa(env.SPOTIFY_CLIENT_ID + ":" + env.SPOTIFY_CLIENT_SECRET);
  var r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Authorization": "Basic " + basic, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials"
  });
  if (!r.ok) throw new Error("Spotify token failed: " + r.status);
  var j = await r.json();
  tokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in - 300) * 1000 };
  return tokenCache.token;
}
async function spotify(path, env) {
  var t = await appToken(env);
  var r = await fetch("https://api.spotify.com" + path, { headers: { "Authorization": "Bearer " + t } });
  if (r.status === 401) { // token rotated; retry once
    tokenCache = { token: null, exp: 0 };
    t = await appToken(env);
    r = await fetch("https://api.spotify.com" + path, { headers: { "Authorization": "Bearer " + t } });
  }
  if (r.status === 429) {
    var ra = parseInt(r.headers.get("Retry-After") || "5", 10);
    var e = new Error("Spotify is rate-limited, retry in " + ra + "s.");
    e.code = "RATE_LIMITED"; e.spotifyStatus = 429; e.path = path; throw e;
  }
  if (r.status === 404) {
    var nf = new Error("Spotify 404 on " + path + ". Either the playlist is private/missing, or this endpoint path was renamed by Spotify.");
    nf.code = "NOT_FOUND"; nf.spotifyStatus = 404; nf.path = path; throw nf;
  }
  if (!r.ok) {
    var g = new Error("Spotify error " + r.status + " on " + path);
    g.code = "SPOTIFY_ERROR"; g.spotifyStatus = r.status; g.path = path; throw g;
  }
  return r.json();
}
// Try /items first (post-Feb-2026 name), fall back to /tracks (pre-2026 name).
// Returns { json, endpointUsed }. Throws the LAST error if both fail.
async function getTracksPage(pid, offset, fields, env) {
  var itemsPath = "/v1/playlists/" + pid + "/items?limit=100&offset=" + offset + "&fields=" + encodeURIComponent(fields);
  var tracksPath = "/v1/playlists/" + pid + "/tracks?limit=100&offset=" + offset + "&fields=" + encodeURIComponent(fields);
  var lastErr = null;
  try {
    var a = await spotify(itemsPath, env);
    return { json: a, endpointUsed: "items" };
  } catch (e) { lastErr = e; }
  try {
    var b = await spotify(tracksPath, env);
    return { json: b, endpointUsed: "tracks" };
  } catch (e2) {
    // Prefer the /items error (new canonical path) for diagnosis, but keep both.
    e2.fallbackFrom = lastErr ? { path: lastErr.path, spotifyStatus: lastErr.spotifyStatus } : null;
    throw e2;
  }
}
async function fetchPlaylist(pid, env, userToken) {
  // userToken set (Plan B): fetch as the guest (ownership OK).
  // userToken null (legacy/app path): app-token fetch (meta-only for others' lists).
  var call = userToken ? function (p) { return userSpotify(p, userToken); }
                       : function (p) { return spotify(p, env); };
  // Meta: request BOTH old (tracks) and new (items) shapes — Feb-2026 renamed
  // playlist.tracks -> playlist.items. One of them will be present.
  var meta = await call("/v1/playlists/" + pid + "?fields=name,public,owner(id,display_name),images,tracks(total),items(total)");
  var total = ((meta.items && meta.items.total) != null ? meta.items.total
    : (meta.tracks && meta.tracks.total)) || 0;
  var itemsAbsent = !meta.items && !meta.tracks;
  var tracks = [], offset = 0, pageCount = 0;
  // Page fields: request BOTH entry shapes — pre-2026 entries are { track: {...} },
  // post-2026 entries are { item: {...} }. Parser below accepts either.
  var fields = "items(item(id,name,artists(name,id),album(name,images),duration_ms,explicit,external_ids(isrc),is_local),track(id,name,artists(name,id),album(name,images),duration_ms,explicit,external_ids(isrc),is_local)),next,total,limit,offset";
  var endpointUsed = null, shapeUsed = null, pageShape = null, rawFirstKeys = null;
  // If meta gave no total (field renames in flight), still attempt one page
  // rather than returning zero songs silently.
  var maxPages = Math.max(1, Math.ceil(Math.min(total, TRACK_CAP) / 100));
  while (pageCount < maxPages) {
    var res = userToken ? await getUserTracksPage(pid, offset, fields, userToken)
                        : await getTracksPage(pid, offset, fields, env);
    if (!endpointUsed) endpointUsed = res.endpointUsed;
    var page = res.json;
    pageCount++;
    if (pageCount === 1 && page && typeof page === "object") {
      rawFirstKeys = Object.keys(page);
      pageShape = page.items && page.items.items ? "items.items[]"
        : Array.isArray(page.items) ? "items[]" : "other:" + rawFirstKeys.join(",");
    }
    var skipped = 0;
    ((page.items && page.items.items) || page.items || []).forEach(function (it) {
      var t = it && (it.item || it.track); // post-2026 shape first, pre-2026 fallback
      if (!shapeUsed && t) shapeUsed = it.item ? "item" : "track";
      if (!t || t.is_local) { skipped++; return; }
      tracks.push({
        id: t.id || null, isrc: (t.external_ids && t.external_ids.isrc) || null,
        title: t.name, artists: (t.artists || []).map(function (a) { return a.name; }),
        popularity: 0, // stripped for Dev Mode apps (Spotify Feb-2026); kept for shape-compat
        durationMs: t.duration_ms || 0,
        image: (t.album && t.album.images && t.album.images[2] && t.album.images[2].url) || null,
        explicit: !!t.explicit
      });
    });
    if (!page.next) break;
    offset += 100;
  }
  return {
    playlistId: pid, name: meta.name, owner: (meta.owner && meta.owner.display_name) || null,
    image: (meta.images && meta.images[1] && meta.images[1].url) || null,
    trackCount: tracks.length, capped: total > TRACK_CAP, tracks: tracks,
    endpointUsed: endpointUsed, shapeUsed: shapeUsed, itemsAbsent: itemsAbsent,
    metaTotal: total, pageShape: pageShape, rawFirstKeys: rawFirstKeys
  };
}

/* Rail headings that mark non-playlist content below the tracklist. The rail
 * title varies ("Recommended", "Fans also like", ...), so cut at the earliest
 * heading-like match. Track titles can't false-positive: the pattern requires
 * the words to span a whole element's text. Mirrored in scrape-server.js. */
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

/* ---- Page scrape (PRIMARY for public lists — v1.7 scrape-first).
 * open.spotify.com playlist pages server-render the FULL track list as plain
 * <a href="/track/{id}">Title</a> + artist links. The Worker fetches the page
 * (server-to-server, no CORS issue) and parses title/artist/track-id triples.
 * No ISRC/popularity/duration/album-art — matching uses Tier 3 (title+artist);
 * ranking is overlap -> title. Honors: single fetch per playlist, desktop UA,
 * 10s timeout. If Spotify changes markup, entries come back short and the
 * caller reports trackCount/metaTotal honestly (never fakes data).
 */

/* Playlist total as printed in the page header ("Playlist · 278 songs").
 * Only a count with "playlist" nearby qualifies; a bare "N songs" elsewhere
 * (bios, descriptions) must not trigger a false partial flag. Null when the
 * header is absent (bot shell, markup change). Mirrored in scrape-server.js. */
function extractTotal(html) {
  var m = html.match(/playlist[^<>]{0,80}?(\d[\d,]*)\s+songs?/i);
  if (!m) return null;
  var n = parseInt(m[1].replace(/,/g, ""), 10);
  return n > 0 ? n : null;
}

async function scrapePlaylistPage(pid) {
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, 10000);
  var html;
  try {
    var r = await fetch("https://open.spotify.com/playlist/" + pid, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });
    if (!r.ok) {
      var e = new Error("Playlist page returned HTTP " + r.status);
      e.code = "PAGE_FETCH"; e.spotifyStatus = r.status; throw e;
    }
    html = await r.text();
  } finally { clearTimeout(timer); }
  // 1) Playlist name from <title>.
  var nameM = html.match(/<title>([^<]*?)(?: - playlist by .*?)?(?: \| Spotify)?<\/title>/i);
  var name = nameM ? nameM[1].trim() : null;
  // 2) Track rows: /track/{22} link (title) followed by /artist/{22} link(s),
  // restricted to the main tracklist region (everything above the rail cut).
  var body = cutRail(html);
  var tracks = [], seen = {};
  var re = /<a[^>]+href="\/track\/([A-Za-z0-9]{22})"[^>]*>([^<]+)<\/a>\s*(?:<[^>]*>)*<a[^>]+href="\/artist\/[A-Za-z0-9]{22}"[^>]*>([^<]+)<\/a>/g;
  var m, guard = 0;
  while ((m = re.exec(body)) && guard < 600) {
    guard++;
    var tid = m[1], title = m[2].trim(), artist = m[3].trim();
    if (!title || !artist || seen[tid]) continue;
    seen[tid] = true;
    // Capture up to 2 artists (collabs): peek next artist link within 300 chars.
    var artists = [artist];
    var rest = body.slice(m.index + m[0].length, m.index + m[0].length + 300);
    var m2 = rest.match(/^[^<]*<a[^>]+href="\/artist\/[A-Za-z0-9]{22}"[^>]*>([^<]+)<\/a>/);
    if (m2 && m2[1].trim() && m2[1].trim() !== artist) artists.push(m2[1].trim());
    tracks.push({ id: tid, isrc: null, title: title, artists: artists,
      popularity: 0, durationMs: 0, image: null, explicit: false, via: "scrape" });
  }
  return { name: name, tracks: tracks, metaTotal: extractTotal(html) };
}

/* ---- KV page cache (cross-room). One fetch/render serves every room.
 * Namespace is versioned: bump it whenever the reader or parser changes so
 * stale/poisoned snapshots (e.g. the 16-track sampled shell) die at once. */
var PAGE_CACHE_NS = "page:v2:";
var PAGE_CACHE_TTL = 86400; // 24h
async function getCachedPage(pid, env) {
  try {
    var c = await env.ROOMS.get(PAGE_CACHE_NS + pid, { type: "json" });
    if (c && Array.isArray(c.tracks) && c.tracks.length) return c;
  } catch (ign) {}
  return null;
}
async function putCachedPage(pid, env, page) {
  try {
    await env.ROOMS.put(PAGE_CACHE_NS + pid, JSON.stringify(page), { expirationTtl: PAGE_CACHE_TTL });
  } catch (ign) { /* cache is best-effort */ }
}

/* ---- Clean-host scraper client (scrape-server.js on non-flagged egress).
 * Trust-but-verify: only id/title/artists cross the boundary; entries are
 * re-validated here, so a compromised or buggy server cannot inject shapes
 * the matcher doesn't understand. */
async function fetchFromScraper(pid, env) {
  var base = String(env.SCRAPER_URL).replace(/\/+$/, "");
  var headers = {};
  if (env.SCRAPER_SECRET) headers["Authorization"] = "Bearer " + env.SCRAPER_SECRET;
  var r = await fetch(base + "/scrape?pid=" + encodeURIComponent(pid),
    { headers: headers, signal: AbortSignal.timeout(25000) });
  if (!r.ok) {
    var he = new Error("Scraper HTTP " + r.status);
    he.code = "SCRAPER_HTTP"; throw he;
  }
  var j = await r.json().catch(function () { return null; });
  if (!j || !Array.isArray(j.tracks)) {
    var se = new Error("Scraper bad shape");
    se.code = "SCRAPER_SHAPE"; throw se;
  }
  var tracks = [];
  j.tracks.forEach(function (t) {
    if (!t || !/^[A-Za-z0-9]{22}$/.test(t.id || "") || !t.title) return;
    tracks.push({ id: t.id, isrc: null, title: String(t.title),
      artists: Array.isArray(t.artists)
        ? t.artists.filter(function (a) { return typeof a === "string" && a; }).slice(0, 2)
        : [],
      popularity: 0, durationMs: 0, image: null, explicit: false, via: "scraper" });
  });
  return { name: (j.name || null), owner: (j.owner || null), tracks: tracks,
    metaTotal: (j && typeof j.metaTotal === "number" && j.metaTotal > 0) ? j.metaTotal : null };
}

/* ---- XHR payload extraction (pure, unit-tested). ----
 * The web player downloads track JSON (api.spotify.com or spclient) before
 * rendering rows. Any captured JSON holding track-shaped entries is usable,
 * whatever the endpoint or envelope: wrapped ({track}/{item}), or bare
 * entries carrying an artists array or duration. Ids are 22-char, so bare
 * artist lists can never false-positive. Largest candidate wins. */
function trackFromEntry(t) {
  if (!t || typeof t !== "object") return null;
  var wrapped = null;
  if (t.item && typeof t.item === "object") wrapped = t.item;
  else if (t.track && typeof t.track === "object") wrapped = t.track;
  var inner = wrapped || t;
  if (!inner || typeof inner !== "object") return null;
  var id = typeof inner.id === "string" ? inner.id : null;
  var title = typeof inner.name === "string" ? inner.name
    : (typeof inner.title === "string" ? inner.title : null);
  if (!id || !/^[A-Za-z0-9]{22}$/.test(id) || !title) return null;
  if (!wrapped && !Array.isArray(inner.artists) &&
      typeof inner.duration_ms !== "number" && typeof inner.duration !== "number") return null;
  var artists = Array.isArray(inner.artists)
    ? inner.artists.map(function (a) { return (a && typeof a === "object" && a.name) || a; })
      .filter(function (a) { return typeof a === "string" && a; })
    : [];
  return { id: id, isrc: null, title: title, artists: artists, popularity: 0,
    durationMs: typeof inner.duration_ms === "number" ? inner.duration_ms : 0,
    image: null, explicit: !!inner.explicit, via: "browser" };
}
function extractTracksFromJson(node) {
  var best = [];
  function scoreList(arr) {
    var got = [];
    for (var i = 0; i < arr.length; i++) {
      var t = trackFromEntry(arr[i]);
      if (t) got.push(t);
    }
    return got.length >= Math.max(1, Math.floor(arr.length / 2)) ? got : null;
  }
  function walk(x) {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) {
      var got = x.length ? scoreList(x) : null;
      if (got && got.length > best.length) best = got;
      for (var i = 0; i < x.length; i++) walk(x[i]);
      return;
    }
    var keys = Object.keys(x);
    for (var j = 0; j < keys.length; j++) walk(x[keys[j]]);
  }
  walk(node);
  var seen = {}, out = [];
  best.forEach(function (t) { if (!seen[t.id]) { seen[t.id] = true; out.push(t); } });
  return out;
}

/* ---- Browser XHR-intercept scrape (fallback when curl gets the bot shell).
 * Needs the BROWSER binding (Browser Run). Captures the player's own track
 * JSON over XHR instead of scrolling the virtualized list: one page load,
 * zero scroll round-trips. Images/media/fonts never download. A bounded DOM
 * scroll-collect is the backstop if no XHR payload parses. */
async function scrapeViaBrowser(pid, env) {
  var mod;
  try {
    mod = await import("@cloudflare/puppeteer");
  } catch (e) {
    var nde = new Error("Browser dependency missing (npm i -D @cloudflare/puppeteer).");
    nde.code = "NO_BROWSER_DEP"; throw nde;
  }
  var puppeteer = mod.default || mod;
  var browser = await puppeteer.launch(env.BROWSER);
  try {
    var page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36");
    await page.setRequestInterception(true);
    page.on("request", function (req) {
      var t = "unknown";
      try { t = req.resourceType(); } catch (ign) {}
      if (t === "image" || t === "media" || t === "font") req.abort();
      else req.continue();
    });
    var payloads = [];
    page.on("response", function (res) {
      var url = "";
      try { url = res.url(); } catch (ign) { return; }
      if (url.indexOf("spotify.com") === -1) return;
      if (!/playlist|track|collection/i.test(url)) return;
      res.json().then(function (j) { if (j) payloads.push(j); }).catch(function () {});
    });
    await page.goto("https://open.spotify.com/playlist/" + pid,
      { waitUntil: "domcontentloaded", timeout: 25000 });
    var rowsOk = true;
    try {
      await page.waitForSelector("[data-testid='tracklist-row']", { timeout: 20000 });
    } catch (se) { rowsOk = false; } // rows missing: XHR JSON may still have landed
    await new Promise(function (r) { setTimeout(r, 1500); }); // let trailing XHR land
    var best = [];
    payloads.forEach(function (p) {
      var got = extractTracksFromJson(p);
      if (got.length > best.length) best = got;
    });
    var pageTitle = "";
    try { pageTitle = await page.title(); } catch (ign) {}
    var nm = pageTitle.match(/^(.*?)(?: - playlist by (.*?))?(?: \| Spotify)?$/);
    var bName = (nm && nm[1] ? nm[1].trim() : null) || null;
    var bOwner = (nm && nm[2] ? nm[2].trim() : null);
    if (!best.length && rowsOk) best = await domScrollCollect(page);
    if (!best.length) {
      var be = new Error("no track data (title: " + (pageTitle || "?") +
        ", json payloads: " + payloads.length + ", rows: " + rowsOk + ")");
      be.code = "NO_TRACK_DATA"; throw be;
    }
    return { name: bName, owner: bOwner, tracks: best };
  } finally {
    await browser.close();
  }
}

/* Bounded DOM scroll-collect (recycling-safe accumulate). Serializes through
 * JSON because evaluate results must cross the protocol boundary as data. */
async function domScrollCollect(page) {
  var raw = await page.evaluate([
    "async function __kcCollect() {",
    "  var seen = {};",
    "  var last = null, stable = 0;",
    "  for (var i = 0; i < 40 && stable < 3; i++) {",
    "    var all = document.querySelectorAll(\"[data-testid='tracklist-row']\");",
    "    for (var j = 0; j < all.length; j++) {",
    "      var links = all[j].getElementsByTagName('a');",
    "      var t = null, arts = [];",
    "      for (var k = 0; k < links.length; k++) {",
    "        var h = links[k].getAttribute('href') || '';",
    "        if (!t && h.indexOf('/track/') === 0) t = links[k];",
    "        else if (h.indexOf('/artist/') === 0) arts.push(links[k].textContent.trim());",
    "      }",
    "      if (!t) continue;",
    "      var m = (t.getAttribute('href') || '').match(/\\/track\\/([A-Za-z0-9]{22})/);",
    "      if (m && !seen[m[1]]) seen[m[1]] = { id: m[1], title: t.textContent.trim(), artists: arts.filter(Boolean).slice(0, 2) };",
    "    }",
    "    var rows = document.querySelectorAll(\"[data-testid='tracklist-row']\");",
    "    var lastEl = rows[rows.length - 1];",
    "    var lm = null;",
    "    if (lastEl) {",
    "      lastEl.scrollIntoView({ block: 'end' });",
    "      var llinks = lastEl.getElementsByTagName('a');",
    "      for (var k2 = 0; k2 < llinks.length && !lm; k2++) {",
    "        lm = (llinks[k2].getAttribute('href') || '').match(/\\/track\\/([A-Za-z0-9]{22})/);",
    "      }",
    "    }",
    "    var lastId = (lm && lm[1]) || null;",
    "    if (lastId === last) stable++; else { stable = 0; last = lastId; }",
    "    await new Promise(function (r) { setTimeout(r, 500); });",
    "  }",
    "  return JSON.stringify({ tracks: Object.keys(seen).map(function (k) { return seen[k]; }) });",
    "}",
    "return __kcCollect();"
  ].join("\n"));
  var parsed = JSON.parse(raw);
  var out = [];
  (parsed.tracks || []).forEach(function (t) {
    if (t && /^[A-Za-z0-9]{22}$/.test(t.id || "")) {
      out.push({ id: t.id, isrc: null, title: t.title || "Unknown",
        artists: Array.isArray(t.artists) ? t.artists : [],
        popularity: 0, durationMs: 0, image: null, explicit: false, via: "browser" });
    }
  });
  return out;
}

/* ---- router ---- */
export default {
  async fetch(req, env) {
    var url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: cors() });
    try {
      // GET / -> health check / landing (browser visits show this, not an error)
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/api" || url.pathname === "/api/")) {
        return json({
          ok: true, service: "karaoke-buddy",
          usage: "Frontend: open the Pages app. API: POST /api/rooms, POST /api/rooms/:code/playlists, GET /api/rooms/:code, GET /api/rooms/:code/results, DELETE /api/rooms/:code.",
          docs: "See README.md in the repo."
        });
      }
      // TEMP DEBUG (bot-shell diagnosis 2026-09-27 — candidate for removal):
      // GET /api/dbgpage?pid=... returns page length, anchor counts, head snippet.
      if (req.method === "GET" && url.pathname === "/api/dbgpage") {
        var dpid = url.searchParams.get("pid") || "";
        if (!ID_RE.test(dpid)) return err("INVALID_URL", "Pass ?pid=<22-char id>.", 400);
        var dr = await fetch("https://open.spotify.com/playlist/" + dpid, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9"
          }
        });
        var dh = await dr.text();
        var trackAnchors = (dh.match(/href="\/track\//g) || []).length;
        var artistAnchors = (dh.match(/href="\/artist\//g) || []).length;
        var hasNextData = dh.indexOf("__NEXT_DATA__") !== -1;
        var hasSpotData = dh.indexOf("Spotify.Entity") !== -1;
        return json({ pageStatus: dr.status, htmlLen: dh.length,
          trackAnchors: trackAnchors, artistAnchors: artistAnchors,
          hasNextData: hasNextData,
          head: dh.slice(0, 600),
          trackCtx: trackAnchors ? dh.slice(Math.max(0, dh.indexOf('href="/track/') - 200), dh.indexOf('href="/track/') + 200) : null });
      }
      // LEAN PROBE: GET /api/tracks?pid=<22-char id> -> full song list, no rooms.
      // Scrape-first (same chain as the room flow). Reports `via` honestly.
      // DIAGNOSIS 2026-09-27: worker IPs get the bot shell (164KB, zero
      // /track/ anchors, <title>Spotify - Web Player</title>). Scrape is DEAD
      // from datacenter IPs. Kept as best-effort; real paths: owned lists
      // (API), collaborator lists (API), file import (no API).
      if (req.method === "GET" && url.pathname === "/api/tracks") {
        var spid = url.searchParams.get("pid") || "";
        if (!ID_RE.test(spid)) return err("INVALID_URL", "Pass ?pid=<22-char playlist id>.", 400);
        var sscraped = null, sscrapeErr = null;
        try {
          var s2 = await scrapePlaylistPage(spid);
          if (s2.tracks.length) sscraped = s2;
        } catch (se) { sscrapeErr = se.message; }
        if (!sscraped || !sscraped.tracks.length) {
          return json({ code: "NOT_READABLE",
            message: "Could not read this playlist from its public page. It may be private, deleted, or region-locked.",
            scrapeError: sscrapeErr || null }, 403);
        }
        return json({ name: sscraped.name, owner: null, image: null,
          trackCount: sscraped.tracks.length, capped: sscraped.tracks.length >= 600,
          tracks: sscraped.tracks, via: "scrape" });
      }
      // PLAN B OAUTH (7-step flow):
      // GET /api/auth/login?room=CODE -> 302 to Spotify authorize (plain
      // Authorization Code; Worker holds client_secret, so no PKCE needed).
      // Redirect URI must be allowlisted in the Spotify dashboard:
      //   https://<worker>/api/auth/callback
      if (req.method === "GET" && url.pathname === "/api/auth/login") {
        var roomQ = (url.searchParams.get("room") || "").toUpperCase();
        if (!/^KTV-[A-Z0-9]{4}$/.test(roomQ)) return err("BAD_ROOM", "Pass ?room=KTV-XXXX.", 400);
        var st = newState();
        await env.ROOMS.put("oauth:" + st, JSON.stringify({ room: roomQ, createdAt: Date.now() }), { expirationTtl: 600 });
        var redirectUri = new URL("/api/auth/callback", url.origin).toString();
        var auth = "https://accounts.spotify.com/authorize?response_type=code" +
          "&client_id=" + encodeURIComponent(env.SPOTIFY_CLIENT_ID) +
          "&scope=" + encodeURIComponent("playlist-read-private") +
          "&redirect_uri=" + encodeURIComponent(redirectUri) +
          "&state=" + encodeURIComponent(st) +
          "&show_dialog=false";
        return Response.redirect(auth, 302);
      }
      // GET /api/auth/callback?code=..&state=.. -> exchange code for tokens,
      // stash per-room guest token in KV (TTL 4h), redirect back to guest page.
      if (req.method === "GET" && url.pathname === "/api/auth/callback") {
        var codeQ = url.searchParams.get("code"), stateQ = url.searchParams.get("state");
        var errQ = url.searchParams.get("error");
        if (errQ) return err("OAUTH_DENIED", "Guest declined Spotify access (" + errQ + ").", 400);
        if (!codeQ || !stateQ) return err("OAUTH_BAD_CALLBACK", "Missing code/state.", 400);
        var oRaw = await env.ROOMS.get("oauth:" + stateQ);
        if (!oRaw) return err("OAUTH_STATE", "Login session expired. Tap Connect again.", 400);
        var o = JSON.parse(oRaw);
        await env.ROOMS.delete("oauth:" + stateQ);
        var redirectBack = new URL("/api/auth/callback", url.origin).toString();
        var tokRes = await fetch("https://accounts.spotify.com/api/token", {
          method: "POST",
          headers: { "Authorization": "Basic " + btoa(env.SPOTIFY_CLIENT_ID + ":" + env.SPOTIFY_CLIENT_SECRET),
                     "Content-Type": "application/x-www-form-urlencoded" },
          body: "grant_type=authorization_code&code=" + encodeURIComponent(codeQ) +
                "&redirect_uri=" + encodeURIComponent(redirectBack)
        });
        var tok = await tokRes.json().catch(function () { return {}; });
        if (!tokRes.ok || !tok.access_token) {
          return err("OAUTH_TOKEN", "Spotify token exchange failed: " + (tok.error_description || tok.error || tokRes.status), 502);
        }
        var guestId = newState().slice(0, 8);
        // Who is this? (display name for the host slot card)
        var meName = null;
        try {
          var meJ = await userSpotify("/v1/me?fields=display_name,id", tok.access_token);
          meName = meJ.display_name || meJ.id || null;
        } catch (ign) {}
        await env.ROOMS.put("guest:" + o.room + ":" + guestId,
          JSON.stringify({ token: tok.access_token,
            refresh: tok.refresh_token || null,
            obtainedAt: Date.now(), name: meName }), { expirationTtl: ROOM_TTL });
        // Back to the guest page (served by Pages) with guest id.
        // PAGES_ORIGIN var or same-origin fallback: use Referer-less join URL pattern.
        var pagesBase = (env.PAGES_ORIGIN || "").replace(/\/+$/, "") || url.origin;
        return Response.redirect(pagesBase + "/?room=" + encodeURIComponent(o.room) +
          "&guest=" + encodeURIComponent(guestId) + "#joined", 302);
      }
      // GET /api/rooms/:code/my-playlists?guest=ID -> guest's own playlists (picker).
      if (req.method === "GET" && /^\/api\/rooms\/[A-Za-z0-9-]+\/my-playlists$/.test(url.pathname)) {
        var gid = url.searchParams.get("guest") || "";
        var rm = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9-]+)\/my-playlists$/);
        var gRaw = await env.ROOMS.get("guest:" + rm[1].toUpperCase() + ":" + gid);
        if (!gRaw) return err("GUEST_UNKNOWN", "Connect Spotify first (tap Connect).", 401);
        var gtok = JSON.parse(gRaw).token;
        try {
          var mine = await listUserPlaylists(gtok);
          return json({ playlists: mine });
        } catch (e) {
          return json({ code: e.code || "SPOTIFY_ERROR", message: e.message }, e.code === "GUEST_TOKEN_EXPIRED" ? 401 : 502);
        }
      }
      // POST /api/rooms -> create
      if (req.method === "POST" && url.pathname === "/api/rooms") {
        var code = roomCode();
        await env.ROOMS.put("room:v1:" + code, JSON.stringify({ code: code, createdAt: Date.now(), slots: [] }), { expirationTtl: ROOM_TTL });
        return json({ code: code, joinUrl: url.origin + "?room=" + code });
      }
      var m = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9-]+)(\/playlists|\/results)?$/);
      if (!m) return err("NOT_FOUND", "Unknown endpoint.", 404);
      var roomKey = "room:v1:" + m[1].toUpperCase();
      var roomRaw = await env.ROOMS.get(roomKey);
      if (!roomRaw) return err("NOT_FOUND", "Room expired or unknown. Start a new room.", 404);
      var room = JSON.parse(roomRaw);

      // GET /api/rooms/:code -> light poll payload
      if (req.method === "GET" && !m[2]) {
        var previews = [];
        for (var i = 0; i < room.slots.length; i++) {
          var s = await env.ROOMS.get(roomKey + ":pl:" + i, { type: "json" });
          if (s) previews.push({ name: s.name, owner: s.owner, image: s.image, trackCount: s.trackCount, playlistId: s.playlistId, metaTotal: s.metaTotal || s.trackCount, partial: !!s.partial });
        }
        return json({ code: room.code, participants: previews });
      }
      // GET /api/rooms/:code/results -> full snapshots for client match
      if (req.method === "GET" && m[2] === "/results") {
        var snaps = [];
        for (var j = 0; j < room.slots.length; j++) {
          var full = await env.ROOMS.get(roomKey + ":pl:" + j, { type: "json" });
          if (full) snaps.push(full);
        }
        return json({ snapshots: snaps, computedAt: Date.now() });
      }
      // POST /api/rooms/:code/playlists { playlistUrl } or { playlistId }
      //   + optional { guest } -> fetch with THAT guest's user token (private lists).
      // FETCH ORDER v1.9 (cache -> scraper -> curl -> browser XHR-intercept):
      // KV page cache first; clean-host scraper when SCRAPER_URL is set (no auth,
      // non-flagged egress); public page scrape PRIMARY fallback (no browser
      // minutes); Browser Run XHR-intercept last resort. Enrichment best-effort.
      if (req.method === "POST" && m[2] === "/playlists") {
        if (room.slots.length >= MAX_PLAYLISTS) return err("ROOM_FULL", "Room is full (" + MAX_PLAYLISTS + "). Remove one first.", 409);
        var body = await req.json().catch(function () { return {}; });
        var pid = extractId(body.playlistUrl || body.playlistId || "");
        if (!pid || !ID_RE.test(pid)) return err("INVALID_URL", "Paste a Spotify playlist link.");
        if (room.slots.indexOf(pid) !== -1) return err("DUPLICATE", "That playlist is already in the room.");
        // Guest token lookup (private-list path only; public needs nothing).
        var gTok = null, gName = null;
        if (body.guest) {
          var ggRaw = await env.ROOMS.get("guest:" + m[1].toUpperCase() + ":" + body.guest);
          if (ggRaw) { var gg = JSON.parse(ggRaw); gTok = gg.token; gName = gg.name; }
        }
        var snap = null, scrapeErr = null;
        // 0) KV PAGE CACHE (cross-room): the fastest scrape is the one skipped.
        var cached = await getCachedPage(pid, env);
        if (cached && cached.tracks.length) {
          snap = { playlistId: pid, name: cached.name, owner: cached.owner || null, image: null,
            trackCount: cached.tracks.length, capped: cached.tracks.length >= 600,
            tracks: cached.tracks, via: "cache",
            endpointUsed: null, shapeUsed: cached.shape || "scrape", itemsAbsent: false,
            metaTotal: cached.metaTotal || cached.tracks.length, pageShape: cached.shape || "scrape" };
        }
        // 1) CLEAN-HOST SCRAPER (no auth; needs SCRAPER_URL + SCRAPER_SECRET).
        if (!snap && env.SCRAPER_URL) {
          try {
            var scraped2 = await fetchFromScraper(pid, env);
            if (scraped2.tracks.length) {
              snap = { playlistId: pid, name: scraped2.name, owner: scraped2.owner, image: null,
                trackCount: scraped2.tracks.length, capped: scraped2.tracks.length >= 600,
                tracks: scraped2.tracks, via: "scraper",
                endpointUsed: null, shapeUsed: "scrape", itemsAbsent: false,
                metaTotal: scraped2.metaTotal || scraped2.tracks.length, pageShape: "scrape" };
              await putCachedPage(pid, env, { name: scraped2.name, owner: scraped2.owner, tracks: scraped2.tracks, shape: "scraper", metaTotal: scraped2.metaTotal });
            }
          } catch (se2) { scrapeErr = (scrapeErr ? scrapeErr + " | " : "") + se2.message; }
        }
        // 2) CURL SCRAPE (no auth, no browser minutes).
        if (!snap) {
          try {
            var scraped = await scrapePlaylistPage(pid);
            if (scraped.tracks.length) {
              snap = { playlistId: pid, name: scraped.name, owner: null, image: null,
                trackCount: scraped.tracks.length, capped: scraped.tracks.length >= 600,
                tracks: scraped.tracks, via: "scrape",
                endpointUsed: null, shapeUsed: "scrape", itemsAbsent: false,
                metaTotal: scraped.metaTotal || scraped.tracks.length, pageShape: "scrape" };
              await putCachedPage(pid, env, { name: scraped.name, owner: null, tracks: scraped.tracks, shape: "scrape", metaTotal: scraped.metaTotal });
            }
          } catch (se) { scrapeErr = se.message; }
        }
        // 3) BROWSER XHR-INTERCEPT (no auth; costs browser minutes, cached above).
        if (!snap && env.BROWSER) {
          try {
            var browsed = await scrapeViaBrowser(pid, env);
            if (browsed.tracks.length) {
              snap = { playlistId: pid, name: browsed.name, owner: browsed.owner, image: null,
                trackCount: browsed.tracks.length, capped: browsed.tracks.length >= 600,
                tracks: browsed.tracks, via: "browser-xhr",
                endpointUsed: null, shapeUsed: "browser", itemsAbsent: false,
                metaTotal: browsed.metaTotal || browsed.tracks.length, pageShape: "browser" };
              await putCachedPage(pid, env, { name: browsed.name, owner: browsed.owner, tracks: browsed.tracks, shape: "browser", metaTotal: browsed.metaTotal });
            }
          } catch (be) { scrapeErr = (scrapeErr ? scrapeErr + " | " : "") + be.message; }
        }
        // 4) API ENRICHMENT (only when a token path exists; best-effort, never fatal).
        if (snap && (gTok || env.SPOTIFY_CLIENT_ID)) {
          try {
            var api = await fetchPlaylist(pid, env, gTok);
            if (api.trackCount > 0) {
              // Merge API fields (ISRC/art/duration) onto scraped tracks by track ID.
              var byId = {};
              api.tracks.forEach(function (t) { if (t.id) byId[t.id] = t; });
              snap.tracks.forEach(function (t) {
                var a = t.id && byId[t.id];
                if (a) { t.isrc = a.isrc || null; t.durationMs = a.durationMs || 0; t.image = a.image || null; t.explicit = !!a.explicit; }
              });
              snap.via = "scrape+api";
              if (!snap.name) snap.name = api.name;
              if (!snap.owner) snap.owner = api.owner;
            }
          } catch (ign) { /* enrichment is best-effort; scraped data stands */ }
        }
        // 5) Guest-token API path (private lists): scrape fails on private pages,
        // so try the API with the guest token directly.
        if (!snap && gTok) {
          try {
            var priv = await fetchPlaylist(pid, env, gTok);
            if (priv.trackCount > 0) {
              snap = priv; snap.via = "api-private";
              snap.itemsAbsent = false;
            }
          } catch (e) {
            var st2 = e.code === "RATE_LIMITED" ? 429 : e.code === "GUEST_TOKEN_EXPIRED" ? 401 : 502;
            return json({ code: e.code || "SPOTIFY_ERROR", message: e.message,
              spotifyStatus: e.spotifyStatus || null }, st2);
          }
        }
        // Honest counts: the header total (when the page prints one) beats the
        // parsed row count; a shortfall is flagged partial instead of stated.
        if (snap) {
          if (typeof snap.metaTotal !== "number" || !(snap.metaTotal > 0)) snap.metaTotal = snap.trackCount;
          snap.partial = snap.metaTotal > snap.trackCount;
        }
        if (!snap || snap.trackCount === 0) {
          return json({ code: "NOT_READABLE",
            message: "Could not read this playlist. If it is public, the page layout may have changed (try again later). If it is private, connect Spotify as a guest first.",
            scrapeError: scrapeErr || null }, 403);
        }
        var slot = room.slots.length;
        room.slots.push(pid);
        await env.ROOMS.put(roomKey, JSON.stringify(room), { expirationTtl: ROOM_TTL });
        await env.ROOMS.put(roomKey + ":pl:" + slot, JSON.stringify(snap), { expirationTtl: ROOM_TTL });
        // Tag the slot with the guest name when known (host sees "Ayu's Gym Mix").
        if (gName) {
          try {
            var tagged = await env.ROOMS.get(roomKey + ":pl:" + slot, { type: "json" });
            if (tagged) { tagged.submittedBy = gName; await env.ROOMS.put(roomKey + ":pl:" + slot, JSON.stringify(tagged), { expirationTtl: ROOM_TTL }); }
          } catch (ign) {}
        }
        return json({ participantId: slot, playlistId: pid, name: snap.name, owner: snap.owner, trackCount: snap.trackCount, image: snap.image, capped: snap.capped, endpointUsed: snap.endpointUsed, shapeUsed: snap.shapeUsed, metaTotal: snap.metaTotal, partial: !!snap.partial, pageShape: snap.pageShape, submittedBy: gName, via: snap.via || "api" });
      }
      // DELETE /api/rooms/:code -> purge
      if (req.method === "DELETE" && !m[2]) {
        for (var k = 0; k < room.slots.length; k++) await env.ROOMS.delete(roomKey + ":pl:" + k);
        await env.ROOMS.delete(roomKey);
        return json({ ok: true });
      }
      return err("NOT_FOUND", "Unknown endpoint.", 404);
    } catch (e) {
      return err("WORKER_ERROR", e.message || "Unexpected error.", 500);
    }
  }
};

// node export for `node --test` (Worker runtime has no `module`).
if (typeof module !== "undefined" && module.exports) { module.exports.extractTracksFromJson = extractTracksFromJson; module.exports.scrapePlaylistPage = scrapePlaylistPage; }
