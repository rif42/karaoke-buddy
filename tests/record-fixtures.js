"use strict";
// Records real Spotify playlist pages to tests/fixtures/page-<pid>.html.
// The replay test serves these bytes back through the REAL worker scrape path,
// so fixtures must be captured where Spotify serves full pages: run this from
// a home network. Datacenter IPs get the bot shell (zero track anchors).
//
// Usage: node tests/record-fixtures.js [pid...]
const DEFAULT_PIDS = [
  "2EQ7KfixtMkBJ8knfYV4Xf",
  "5wndxpncEMNYxGelrpTJNi",
];

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function fetchPage(pid) {
  const r = await fetch("https://open.spotify.com/playlist/" + pid, {
    signal: AbortSignal.timeout(25000),
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} for playlist ${pid}`);
  return r.text();
}

// Mirrors worker scrapePlaylistPage() anchor parsing -- reporting only.
// The test itself exercises the real worker code path, not this copy.
function parseTracks(html) {
  const cut = html.search(/Recommended/i);
  const body = cut > 0 ? html.slice(0, cut) : html;
  const tracks = [];
  const re = /<a[^>]+href="\/track\/([A-Za-z0-9]{22})"[^>]*>([^<]+)<\/a>\s*(?:<[^>]*>)*<a[^>]+href="\/artist\/[A-Za-z0-9]{22}"[^>]*>([^<]+)<\/a>/g;
  let m;
  while ((m = re.exec(body)) && tracks.length < 600) {
    tracks.push({ id: m[1], title: m[2].trim(), artists: [m[3].trim()] });
  }
  return tracks;
}

async function main() {
  const pids = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_PIDS;
  for (const pid of pids) {
    if (!/^[A-Za-z0-9]{22}$/.test(pid)) {
      throw new Error(
        `Invalid playlist id "${pid}" (${pid.length} chars, need 22). ` +
        "Paste the complete open.spotify.com/playlist/... URL."
      );
    }
  }
  const dir = path.join(__dirname, "fixtures");
  fs.mkdirSync(dir, { recursive: true });
  const all = [];
  for (const pid of pids) {
    const html = await fetchPage(pid);
    const anchors = (html.match(/href="\/track\//g) || []).length;
    const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || "(no title)";
    console.log(`${pid}: ${html.length} bytes, ${anchors} track anchors, title: ${title}`);
    if (!anchors) {
      throw new Error(
        `Playlist ${pid} returned zero track anchors (bot shell). ` +
        "This network is blocked by Spotify page fetches -- run from a home network."
      );
    }
    fs.writeFileSync(path.join(dir, `page-${pid}.html`), html);
    const tracks = parseTracks(html);
    console.log(`  parsed ${tracks.length} tracks`);
    all.push({ pid, tracks });
  }
  // Overlap report -- paste this back so pinned test assertions can be written.
  const key = (t) => `${t.title.toLowerCase()}|${t.artists.join("&").toLowerCase()}`;
  const sets = all.map((p) => new Set(p.tracks.map(key)));
  const universe = [...new Set(all.flatMap((p) => p.tracks.map(key)))];
  const n = sets.length;
  const inAll = universe.filter((k) => sets.every((s) => s.has(k)));
  console.log(`\nrecorded ${all.map((p) => `${p.pid}=${p.tracks.length}`).join(", ")}`);
  console.log(`overlap ${n}/${n}: ${inAll.length}`);
  inAll.slice(0, 20).forEach((k) => console.log(`  ALL: ${k}`));
  if (n > 2) {
    const inPartial = universe.filter((k) => sets.filter((s) => s.has(k)).length === n - 1);
    console.log(`overlap ${n - 1}/${n}: ${inPartial.length}`);
    inPartial.slice(0, 20).forEach((k) => console.log(`  ${n - 1}/${n}: ${k}`));
  }
}

main().catch((e) => { console.error("record-fixtures FAILED: " + e.message); process.exit(1); });
