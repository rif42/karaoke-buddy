/* Karaoke Consensus — vanilla app.js (no deps, no build).
 * Sections: config / api / match (pure) / ui / store / boot.
 * PRD v1.2: Pages frontend + Worker proxy + KV rooms. */

/* ---------- config ---------- */
var MAX_PLAYLISTS = 5; // raise to 10 later (PRD FR-002)
var POLL_MS = 2000;
var WORKER_URL = "https://karaoke-buddy.rif42.workers.dev"; // live worker (Option A spike)
var LS_ROOM = "kc:room:v1";
var LS_SNAP = "kc:pl:"; // + playlistId, { fetchedAt, tracks }

/* ---------- tiny dom helpers ---------- */
function $(id) { return document.getElementById(id); }
function el(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function show(id) { $(id).classList.remove("hidden"); }
function hide(id) { $(id).classList.add("hidden"); }

/* ---------- store (localStorage) ---------- */
var store = {
  getRoom: function () { try { return JSON.parse(localStorage.getItem(LS_ROOM) || "null"); } catch (e) { return null; } },
  setRoom: function (r) { try { localStorage.setItem(LS_ROOM, JSON.stringify(r)); } catch (e) {} },
  clearRoom: function () { try { localStorage.removeItem(LS_ROOM); } catch (e) {} },
  getSnap: function (pid) {
    try {
      var s = JSON.parse(localStorage.getItem(LS_SNAP + pid) || "null");
      if (s && Date.now() - s.fetchedAt < 24 * 3600 * 1000) return s;
    } catch (e) {}
    return null;
  },
  setSnap: function (pid, tracks) {
    try { localStorage.setItem(LS_SNAP + pid, JSON.stringify({ fetchedAt: Date.now(), tracks: tracks })); }
    catch (e) { /* quota: evict oldest kc:pl:* and retry once */ try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(LS_SNAP) === 0) { localStorage.removeItem(k); break; }
      }
      localStorage.setItem(LS_SNAP + pid, JSON.stringify({ fetchedAt: Date.now(), tracks: tracks }));
    } catch (e2) {} }
  }
};

/* ---------- api (Worker) ---------- */
function api(path, opts) {
  return fetch(WORKER_URL + path, opts).then(function (r) {
    return r.json().then(function (j) {
      // Attach full diagnostic body so callers can show endpoint/shape detail.
      if (!r.ok) {
        var e = new Error((j && j.message) || ("HTTP " + r.status));
        e.detail = j; e.http = r.status;
        throw e;
      }
      return j;
    });
  });
}
function extractPlaylistId(url) {
  if (!url) return null;
  var m = String(url).trim().match(/(?:open\.spotify\.com\/playlist\/|spotify:playlist:)([A-Za-z0-9]{22})/);
  return m ? m[1] : null;
}

/* ---------- match (pure, deterministic — unit-testable) ---------- */
function normTitle(t) {
  return String(t || "").toLowerCase().normalize("NFKD")
    .replace(/\((remaster[^)]*|remastered[^)]*)\)/gi, "")
    .replace(/-\s*remaster.*$/i, "")
    .replace(/\s+/g, " ").trim();
}
function normArtists(arr) {
  return (arr || []).map(function (a) { return String(a).toLowerCase().trim(); })
    .sort().join(" & ");
}
function matchPlaylists(snapshots) {
  // snapshots: Array<Array<track>> where track = { id, isrc, title, artists[], popularity, durationMs, image }
  var groups = {}; // key -> { song fields, presentIn:Set }
  snapshots.forEach(function (tracks, pi) {
    var seen = {}; // dedup within playlist
    tracks.forEach(function (t) {
      var idKey = t.id ? "id:" + t.id : null;
      var isrcKey = t.isrc ? "isrc:" + String(t.isrc).toUpperCase() : null;
      var taKey = "ta:" + normTitle(t.title) + "|" + normArtists(t.artists);
      var key = idKey || isrcKey || taKey;
      var g = groups[key];
      // Tier-2 merge: same ISRC under different id keys
      if (!g && isrcKey) {
        for (var k in groups) {
          if (groups[k].isrc && groups[k].isrc === String(t.isrc).toUpperCase()) { g = groups[k]; key = k; break; }
        }
      }
      if (!g) {
        g = groups[key] = {
          key: key, isrc: t.isrc ? String(t.isrc).toUpperCase() : null,
          title: t.title, artists: t.artists, image: t.image,
          popularity: t.popularity || 0, durationMs: t.durationMs || 0,
          presentIn: {}, tier: idKey ? 1 : (isrcKey ? 2 : 3)
        };
      }
      if (!seen[key]) { seen[key] = true; g.presentIn[pi] = true; }
      // popularity is stripped for Dev Mode apps (Spotify Feb-2026); keep field
      // for forward-compat but do NOT rank on it — see sort below.
      if ((t.popularity || 0) > g.popularity) g.popularity = t.popularity;
    });
  });
  var out = Object.keys(groups).map(function (k) {
    var g = groups[k];
    g.overlap = Object.keys(g.presentIn).length;
    return g;
  });
  // Ranking: overlap DESC, duration ASC (karaoke: shorter = more singable),
  // title ASC. popularity deliberately excluded (always 0 for Dev Mode apps).
  // If Spotify ever restores it, re-add (b.popularity - a.popularity) as 2nd key.
  out.sort(function (a, b) {
    return (b.overlap - a.overlap) ||
      (a.durationMs - b.durationMs) || (a.title < b.title ? -1 : 1);
  });
  return out;
}
function jaccard(a, b) {
  // a, b: Sets of song keys
  var inter = 0;
  a.forEach(function (k) { if (b.has(k)) inter++; });
  var uni = new Set(Array.from(a).concat(Array.from(b))).size;
  return uni ? inter / uni : 0;
}
// node export for `node --test` without touching browser globals
if (typeof module !== "undefined") { module.exports = { normTitle: normTitle, normArtists: normArtists, matchPlaylists: matchPlaylists, jaccard: jaccard, extractPlaylistId: extractPlaylistId, MAX_PLAYLISTS: MAX_PLAYLISTS }; }

/* ---------- ui ---------- */
var state = { code: null, isHost: false, pollTimer: null, lastResults: [] };
var SLOT_COLORS = ["chip-a", "chip-b", "chip-c", "chip-d", "chip-e"];

function setError(which, msg) { $(which).textContent = msg || ""; }

function joinUrl(code) { return location.origin + location.pathname + "?room=" + encodeURIComponent(code); }

// Minimal QR: draw room URL as text fallback + optional qrserver image.
// Day-1: big code + copy-link. QR <img> upgrades when online (1 line, no dep).
function renderRoomCode(code) {
  $("room-code").textContent = code;
  var c = $("qr");
  var ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 160, 160);
  ctx.fillStyle = "#000"; ctx.font = "bold 20px monospace"; ctx.textAlign = "center";
  ctx.fillText(code.slice(0, 4), 80, 72);
  ctx.fillText(code.slice(4), 80, 100);
  ctx.font = "10px monospace"; ctx.fillText("scan w/ camera", 80, 124);
  ctx.fillText("or type code", 80, 138);
}

function renderSlots(participants) {
  var ul = $("slots"); ul.innerHTML = "";
  $("slot-count").textContent = "(" + participants.length + "/" + MAX_PLAYLISTS + ")";
  participants.forEach(function (p, i) {
    var li = el("li", "slot");
    if (p.image) { var img = el("img"); img.src = p.image; img.alt = ""; li.appendChild(img); }
    var div = el("div");
    div.appendChild(el("div", "who", "Guest " + String.fromCharCode(65 + i)));
    div.appendChild(el("div", "meta", (p.name || p.playlistId) + " · " + p.trackCount + " tracks"));
    li.appendChild(div);
    if (state.isHost) {
      var x = el("button", "x", "✕");
      x.setAttribute("aria-label", "Remove playlist " + (i + 1));
      x.onclick = function () { removeSlot(i); };
      li.appendChild(x);
    }
    ul.appendChild(li);
  });
  for (var i = participants.length; i < MAX_PLAYLISTS; i++) {
    ul.appendChild(el("li", "slot empty", "Slot " + String.fromCharCode(65 + i) + " — waiting for a guest…"));
  }
  $("btn-compute").disabled = participants.length < 2;
}

function renderResults(songs, n, viaNote) {
  var box = $("groups"); box.innerHTML = "";
  // v1.7 scrape-first: scraped tracks carry no ISRC, so Tier 1/2 rarely fire.
  // Tier-3 (title+artist) matches are the standard headline, not second-class.
  var full = songs.filter(function (s) { return s.overlap === n; });
  var rest = songs.filter(function (s) { return s.overlap < n && s.overlap >= 2; });
  $("summary").textContent = full.length + " in all " + n + " · " +
    rest.length + " partial · matched by title+artist, ranked by overlap → title" +
    (viaNote ? " · " + viaNote : "");
  function group(title, list) {
    if (!list.length) return;
    box.appendChild(el("h3", null, title + " (" + list.length + ")"));
    list.slice(0, 50).forEach(function (s) {
      var row = el("div", "song");
      if (s.image) { var img = el("img"); img.src = s.image; img.alt = ""; row.appendChild(img); }
      var d = el("div");
      d.appendChild(el("div", "t", s.title));
      d.appendChild(el("div", "a", (s.artists || []).join(", ")));
      var chips = el("div", "chips");
      Object.keys(s.presentIn).forEach(function (pi) {
        chips.appendChild(el("span", "chip " + SLOT_COLORS[pi % 5], String.fromCharCode(65 + (+pi))));
      });
      d.appendChild(chips);
      row.appendChild(d);
      box.appendChild(row);
    });
  }
  group("✅ In all " + n, full);
  for (var o = n - 1; o >= 2; o--) {
    group("In " + o + "/" + n, rest.filter(function (s) { return s.overlap === o; }));
  }
  state.lastResults = full.concat(rest);
  show("results");
}

/* ---------- host flow ---------- */
function startRoom() {
  setError("host-error", "");
  api("/api/rooms", { method: "POST" })
    .then(function (r) {
      state.code = r.code; state.isHost = true;
      store.setRoom({ code: r.code, isHost: true });
      hide("view-landing"); show("view-host");
      renderRoomCode(r.code);
      pollRoom();
      state.pollTimer = setInterval(pollRoom, POLL_MS);
    })
    .catch(function (e) { setError("host-error", e.message); });
}
function pollRoom() {
  if (!state.code) return;
  api("/api/rooms/" + encodeURIComponent(state.code))
    .then(function (r) { renderSlots(r.participants || []); setError("host-error", ""); })
    .catch(function (e) { setError("host-error", e.message); });
}
function removeSlot(i) {
  // MVP: delete participant client-side view only if worker supports it; else reload.
  pollRoom();
}
function computeResults() {
  setError("host-error", "");
  api("/api/rooms/" + encodeURIComponent(state.code) + "/results")
    .then(function (r) {
      var snaps = r.snapshots || [];
      // browser cache assist: fill any missing snapshot from localStorage
      var songs = matchPlaylists(snaps.map(function (s) { return s.tracks || []; }));
      renderResults(songs, snaps.length);
      // persist snapshots locally (KV write budget: avoid re-fetch writes on re-runs)
      snaps.forEach(function (s) { if (s.playlistId) store.setSnap(s.playlistId, s.tracks || []); });
    })
    .catch(function (e) { setError("host-error", e.message); });
}

/* ---------- guest flow (Plan B: connect -> pick own playlist -> submit) ---------- */
function guestJoin(code, guestId) {
  state.code = code; state.isHost = false;
  state.guestId = guestId || null;
  hide("view-landing"); hide("view-host"); show("view-guest");
  $("guest-code").textContent = code;
  if (state.guestId) loadGuestPlaylists();
}
function guestConnect() {
  // Full-page redirect to Spotify via the worker; callback returns with ?guest=ID.
  location.href = WORKER_URL + "/api/auth/login?room=" + encodeURIComponent(state.code);
}
function loadGuestPlaylists() {
  setError("guest-error", "");
  hide("guest-connect-box"); show("guest-pick-box");
  var ul = $("guest-playlists");
  ul.innerHTML = "";
  ul.appendChild(el("li", "slot empty", "Loading your playlists…"));
  api("/api/rooms/" + encodeURIComponent(state.code) + "/my-playlists?guest=" + encodeURIComponent(state.guestId || ""))
    .then(function (r) {
      ul.innerHTML = "";
      var pls = r.playlists || [];
      if (!pls.length) ul.appendChild(el("li", "slot empty", "No playlists found on your account."));
      pls.forEach(function (p) {
        var li = el("li", "slot");
        if (p.image) { var img = el("img"); img.src = p.image; img.alt = ""; li.appendChild(img); }
        var div = el("div");
        div.appendChild(el("div", "who", p.name || p.id));
        div.appendChild(el("div", "meta", (p.trackCount || 0) + " tracks"));
        li.appendChild(div);
        var go = el("button", "btn small", "Submit");
        go.onclick = function () { guestSubmitPlaylist(p.id); };
        li.appendChild(go);
        ul.appendChild(li);
      });
    })
    .catch(function (e) {
      ul.innerHTML = "";
      var msg = (e.detail && e.detail.code === "GUEST_UNKNOWN")
        ? "Session lost — tap Connect Spotify again."
        : e.message;
      setError("guest-error", msg);
      show("guest-connect-box"); hide("guest-pick-box");
    });
}
function guestSubmitPlaylist(pid) {
  setError("guest-error", "");
  api("/api/rooms/" + encodeURIComponent(state.code) + "/playlists",
    { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playlistId: pid, guest: state.guestId }) })
    .then(function (r) {
      $("guest-ok").classList.remove("hidden");
      $("guest-ok").textContent = "You're in with \"" + (r.name || "playlist") + "\" (" + r.trackCount + " songs" +
        (r.via && r.via !== "api" ? ", via " + r.via : "") + ")! You can close this page. 🎉";
      hide("guest-pick-box");
      var f = $("form-guest"); if (f) f.classList.add("hidden");
    })
    .catch(function (e) {
      setError("guest-error", e.message);
    });
}
function guestSubmit(link) {
  // Paste fallback: still tagged with the guest token when connected.
  var pid = extractPlaylistId(link);
  if (!pid) { setError("guest-error", "Pick one of your playlists above, or paste a Spotify playlist link."); return; }
  guestSubmitPlaylist(pid);
}

/* ---------- lean spike: playlist URL -> song list (no rooms) ---------- */
function browsePlaylist(link) {
  var pid = extractPlaylistId(link);
  var meta = $("browse-meta"), list = $("browse-list");
  list.innerHTML = "";
  if (!pid) { meta.textContent = "That doesn't look like a Spotify playlist link."; return; }
  meta.textContent = "Loading…";
  fetch(WORKER_URL + "/api/tracks?pid=" + encodeURIComponent(pid))
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; }); })
    .then(function (r) {
      if (!r.ok) {
        var b = r.body || {};
        meta.textContent = "❌ HTTP " + r.status + " " + (b.code || "") + ": " + (b.message || "failed") +
          (b.endpointUsed ? " [via /" + b.endpointUsed + ", shape " + (b.shapeUsed || "?") + "]" : "") +
          (b.pageShape ? " page=" + b.pageShape : "") +
          (b.code === "NOT_READABLE" ? " — try a playlist you created." : "");
        return;
      }
      var tracks = r.body.tracks || [];
      meta.textContent = "✅ " + (r.body.name || "Playlist") + " — " + tracks.length + " songs" +
        (r.body.capped ? " (capped 500)" : "") +
        " · via " + (r.body.via || "scrape");
      tracks.forEach(function (t, i) {
        var row = el("div", "song");
        if (t.image) { var img = el("img"); img.src = t.image; img.alt = ""; row.appendChild(img); }
        var d = el("div");
        d.appendChild(el("div", "t", (i + 1) + ". " + t.title));
        d.appendChild(el("div", "a", (t.artists || []).join(", ")));
        row.appendChild(d);
        list.appendChild(row);
      });
    })
    .catch(function (e) { meta.textContent = "❌ network: " + e.message; });
}

/* ---------- boot ---------- */
document.addEventListener("DOMContentLoaded", function () {
  var m = /[?&]room=([A-Za-z0-9-]+)/.exec(location.search);
  var gm = /[?&]guest=([A-Za-z0-9_-]+)/.exec(location.search);
  var saved = store.getRoom();
  if (m) guestJoin(m[1].toUpperCase(), gm ? gm[1] : null);
  else if (saved && saved.code) {
    state.code = saved.code; state.isHost = !!saved.isHost;
    hide("view-landing"); show("view-host");
    renderRoomCode(saved.code);
    pollRoom();
    state.pollTimer = setInterval(pollRoom, POLL_MS);
  }
  $("btn-start").onclick = startRoom;
  $("form-join").onsubmit = function (e) {
    e.preventDefault();
    var c = $("input-code").value.trim().toUpperCase();
    if (c) location.search = "?room=" + encodeURIComponent(c);
  };
  $("form-guest").onsubmit = function (e) { e.preventDefault(); guestSubmit($("input-guest-link").value); };
  $("btn-connect").onclick = guestConnect;
  $("form-host-paste").onsubmit = function (e) {
    e.preventDefault();
    var link = $("input-host-link").value;
    var pid = extractPlaylistId(link);
    if (!pid) { setError("host-error", "That doesn't look like a Spotify playlist link."); return; }
    api("/api/rooms/" + encodeURIComponent(state.code) + "/playlists",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ playlistUrl: link }) })
      .then(function () { $("input-host-link").value = ""; pollRoom(); })
      .catch(function (err) { setError("host-error", err.message); });
  };
  $("btn-clipboard").onclick = function () {
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(function (t) { $("input-host-link").value = t; })
        .catch(function () { setError("host-error", "Clipboard blocked — long-press → paste instead."); });
    } else setError("host-error", "Clipboard API unavailable — long-press → paste instead.");
  };
  $("btn-copy-link").onclick = function () {
    var u = joinUrl(state.code);
    if (navigator.clipboard) navigator.clipboard.writeText(u);
    else { window.prompt("Copy invite link:", u); }
  };
  $("btn-close-room").onclick = function () {
    if (!state.code) return;
    api("/api/rooms/" + encodeURIComponent(state.code), { method: "DELETE" }).finally(function () {
      clearInterval(state.pollTimer); store.clearRoom(); location.search = "";
    });
  };
  $("btn-compute").onclick = computeResults;
  $("form-browse").onsubmit = function (e) { e.preventDefault(); browsePlaylist($("input-browse-link").value); };
  $("btn-copy-queue").onclick = function () {
    var lines = state.lastResults.slice(0, 30).map(function (s, i) {
      return (i + 1) + ". " + s.title + " — " + (s.artists || []).join(", ");
    });
    var done = function () { $("copy-ok").classList.remove("hidden"); };
    if (navigator.clipboard) navigator.clipboard.writeText(lines.join("\n")).then(done);
    else { window.prompt("Copy queue:", lines.join("\n")); done(); }
  };
});
