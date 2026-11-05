# Karaoke Buddy — deploy runbook (Cloudflare free tier, $0) · v1.7 scrape-first

## How fetching works now (read this first)

**Scrape-first, zero auth for public playlists.** The Worker fetches the public
playlist page (`open.spotify.com/playlist/{id}`) server-side and parses the
server-rendered track list (title/artist/track-ID, verified 16/16). No login,
no allowlist, infinite guests. The Spotify Web API is used only for metadata +
owned-list enrichment (best-effort). Per-guest OAuth exists ONLY for private
playlists. Matching is Tier-3 (normalized title+artist); ranking is
overlap → title. There is deliberately no popularity signal (stripped for Dev
Mode since Feb-2026).

## 0. Prereqs
- Cloudflare account (free).
- `npm i -g wrangler` then `wrangler login`.
- Spotify app OPTIONAL for public-only use (needed only for metadata
  enrichment + private-list OAuth). If skipped, public flow still works.

## 1. Spotify app (only if you want enrichment/private lists)
1. https://developer.spotify.com/dashboard → Create app.
2. Redirect URIs: add `https://karaoke-buddy.rif42.workers.dev/api/auth/callback`
   (required ONLY for the private-list guest OAuth; harmless otherwise).
3. Copy Client ID + Secret → `wrangler secret put` (below).
4. Owner account must keep Spotify Premium active (Dev Mode rule, applies only
   when using API paths). No Premium needed for pure scrape flow.
5. NO allowlist needed for public playlists. Allowlist (max 5) applies ONLY to
   guests using the private-list OAuth path.

## 2. Worker (rooms + scrape + optional API)
```bash
cd karaoke-buddy
# KV already bound (karaoke-buddy: 63697454046f49df9899a59f7bb1bc59)
wrangler secret put SPOTIFY_CLIENT_ID      # optional (enrichment/private only)
wrangler secret put SPOTIFY_CLIENT_SECRET  # optional (enrichment/private only)
npx wrangler deploy
# → https://karaoke-buddy.rif42.workers.dev
# sanity: / returns {"ok":true,"service":"karaoke-buddy"...}
```

## 3. Pages (vanilla frontend)
1. Dashboard → **Pages** → Connect repo, root `karaoke-buddy/`,
   build command *(empty)*, output `.`.
2. `WORKER_URL` in `app.js` is already
   `https://karaoke-buddy.rif42.workers.dev`. Change only if Worker URL differs.
3. Set `PAGES_ORIGIN` in `wrangler.toml` to the Pages URL (used ONLY by the
   private-list OAuth callback), redeploy worker.

## 4. Smoke test (no party needed)
1. `GET /api/tracks?pid=4RiOBZIhsahgJrFMcivXwL` → expect 16 tracks, `via:"scrape"`.
2. Pages URL → **Start a room** → note code.
3. New tab → `?room=CODE` → paste 2 public playlist links (no login!) →
   host sees both → **Find common songs** → ranked groups.
4. **Copy queue as text** → KTV/YouTube search.

## 5. Free-tier watchlist
| Cap | Free | You use | Action at 80% |
|---|---|---|---|
| Worker reqs | 100k/day | ~7/session (scrape=1 fetch/list) | Upgrade $5/mo → 10M |
| KV writes | 1k/day | ~6/room | Browser cache avoids refetch; then upgrade |
| KV reads | 100k/day | ~2s poll × session | Lengthen poll to 3s if needed |
| Pages static | unlimited | 5 files | — |

## 6. When things return 0 songs
- Public list + 0 songs → Spotify changed page markup. The response includes
  `scrapeError`; matching never fakes data. Check `via` field in output.
- Private list + 0 songs → expected: connect Spotify as guest (OAuth path).
- Deleted/region-locked → 403 NOT_READABLE with reason.

## 7. Raising MAX_PLAYLISTS 5 → 10 later
Change `MAX_PLAYLISTS` in **both** `app.js` and `worker.js`, redeploy Pages + Worker.
Pairwise UI already collapses beyond 10 pairs. Watch KV writes (11/room) + fetch time.

## 8. ToS note
Page scraping is read-only, 1 fetch per playlist, no credentials abused — but it
sits in Spotify ToS gray area (their API terms prefer API use). Risk profile for
a personal party tool at low volume: low. If Spotify blocks worker-IP page
fetches, the app degrades to API paths (owned lists + OAuth) automatically.

## 9. Scrape microservice (optional, needs clean egress)
Spotify walls Cloudflare IPs on every no-login path (curl, fleet browser,
embed, app-token track reads). If guests must stay login-free, run the
scraper where Spotify serves full pages (home box, clean VPS):
  SCRAPER_SECRET=$(openssl rand -hex 32) PORT=8787 node scrape-server.js
  cloudflared tunnel --url http://localhost:8787   # note the https URL
  wrangler secret put SCRAPER_SECRET                # same value as server env
  # wrangler.toml: SCRAPER_URL = "https://<tunnel-host>" (empty = disabled)
  wrangler deploy
The worker tries cache -> scraper -> curl -> browser; scraped pages cache
24h in KV, so one render serves every room.
