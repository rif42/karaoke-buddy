# Technical PRD — Karaoke Consensus (Spotify Playlist Overlap Finder)

## Document Header

**Product/Feature Name:** Karaoke Consensus — Multi-Playlist Overlap Finder for Karaoke
**Status:** Draft
**Author:** PM (AI-assisted via prd-generator / Technical PRD)
**Stakeholders:** Product, Engineering, Design (solo / small team)
**Date Created:** 2026-09-25
**Last Updated:** 2026-09-25
**Version:** 1.2 (Technical PRD — LOCKED: paste-only, max 5→10, list-only, vanilla frontend + Cloudflare Pages + Worker proxy + room-sync)

---

## Executive Summary

**One-liner:** Host shows one QR, up to 5 friends submit their playlists from their own phones, and the room instantly sees which songs everyone knows.

**Overview:** When 3+ friends do karaoke, 15–30 minutes are wasted scrolling, vetoing, and settling for a song only one person knows. Karaoke Consensus is a lightweight web app that takes Spotify playlists from each person in the room, reads the tracks, computes intersections (3/3 full overlap, 2/3 partial overlap), and outputs a ranked "sing-together" list with the highest probability everyone can sing along.

MVP is deliberately narrow: paste-only, no login required, public playlist links in, ranked overlap list out (list-only, no save-as-playlist). Max 5 playlists for MVP (`MAX_PLAYLISTS=5`, raisable to 10). Stack: vanilla HTML/CSS/JS frontend on Cloudflare Pages + one Cloudflare Worker (free tier) + KV-backed room rendezvous (TTL ~4h). FETCH MODEL (LOCKED v1.7, scrape-first): the Worker reads track lists from the public playlist page (server-rendered, no auth) for ALL public playlists -- zero logins, zero allowlist, infinite guests. The Spotify Web API is retained for playlist metadata + owned-list fast path; per-guest OAuth exists ONLY for private playlists. Nobody logs into anything for public lists: host opens app, guests scan a QR room code and submit links from their own phones. This doc is the **Technical PRD** variant -- engineering is the primary audience.ick Facts:**
- **Target Users:** Groups of 2–6 friends at karaoke / parties, ages 16–35, all with Spotify playlists
- **Problem Solved:** "We can't find a song we all like/know for karaoke"
- **Key Metric (North Star):** Successful overlap sessions (sessions with ≥2 playlists that reach a results view)
- **Target Launch:** MVP in 3 weeks (T-shirt size: M)

---

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Goals & Objectives](#goals--objectives)
3. [User Personas](#user-personas)
4. [User Stories & Requirements](#user-stories--requirements)
5. [Success Metrics](#success-metrics)
6. [Scope](#scope)
7. [Technical Considerations](#technical-considerations)
8. [Design & UX Requirements](#design--ux-requirements)
9. [Timeline & Milestones](#timeline--milestones)
10. [Risks & Mitigation](#risks--mitigation)
11. [Dependencies & Assumptions](#dependencies--assumptions)
12. [Open Questions](#open-questions)
13. [Stakeholder Sign-Off](#stakeholder-sign-off)

---

## Problem Statement

### The Problem

Groups doing karaoke cannot quickly find a song that multiple people (e.g., 3 friends) all like or know. Manual comparison of tastes is slow, awkward, and ends in veto loops or one person dominating song choice.

### Current State

Today users:
1. Ask around verbally ("what songs do you like?").
2. Each person scrolls their own Spotify / phone.
3. Type guesses into the karaoke machine / YouTube search one at a time.
4. Get vetoed, repeat.

Workarounds: shared notes, one person DJs, screenshots of playlists. None compute overlap systematically.

### Impact

**User Impact:**
- 15–30 min wasted per karaoke session on song selection (estimate, to validate in beta).
- Lower fun: singing unfamiliar songs; shy participants drop out.
- Phone-battery / context-switching friction in a dark KTV room.

**Business Impact (for this project):**
- If positioned as portfolio / indie product: activation hinges entirely on "time-to-first-overlap-list" — if >2 min, users abandon and go back to manual search.
- Support / maintenance cost is low, but Spotify API dependency is a single point of failure.

### Why Now?

- Spotify Web API provides FULL public-playlist track lists via server-rendered pages (title/artist/track-ID, verified 16/16, zero auth). Web API retained for metadata + owned-list fast path only (Feb-2026: contents own-or-collaborate-only; popularity stripped) (Client Credentials) tokens — no user login needed for public data.
- **Architecture (LOCKED v1.2): Cloudflare Pages (vanilla static, unlimited free) + one Cloudflare Worker (free: 100k req/day) as Spotify proxy + KV room rendezvous (free: 100k reads/day, 1k writes/day).** The Worker holds `SPOTIFY_CLIENT_ID/SECRET`, mints app tokens server-side, paginates `GET /v1/playlists/{id}/tracks`, adds CORS headers, and exposes room endpoints. Frontend stays vanilla `fetch()` — no framework, no build.
- Multi-device party flow (host QR → guests submit from own phones) eliminates all manual copy-paste and the iOS Share-Target gap — ideal for a lightweight party app.
- Scope is small enough for MVP validation; no login complexity at all for public lists (scrape), OAuth reserved for private lists.

---

## Goals & Objectives

### Business Goals

1. **Validate the overlap mechanic:** 60% of started sessions reach a results view in beta.
2. **Keep build cost minimal:** vanilla frontend (3 files, zero deps) + one Worker file + `wrangler.toml`; total infra cost $0 (all free tiers).
3. **Multi-device party flow:** host shows one QR/room code; guests submit from their own phones; host screen live-updates — zero copy-paste, zero installs, zero logins.

### User Goals

1. As a karaoke group, find 5+ songs we all know in under 2 minutes.
2. Understand *how similar* our tastes are (full vs. partial overlap, similarity score) to guide picks.
3. Leave with a final queue / playlist we can use at the machine immediately.

### Non-Goals

- We are NOT building a karaoke player, lyrics display, or pitch/key changer in MVP.
- We are NOT guaranteeing karaoke-track availability (whether the KTV system actually has the song).
- We are NOT building taste recommendation / ML discovery in MVP — only deterministic intersection of provided playlists.
- We are NOT handling private Spotify playlists in MVP (LOCKED: paste-only public links; no OAuth picker — revisit if >30% adds fail as private).
- We are NOT building save-as-Spotify-playlist / export-to-Spotify (LOCKED: list-only — copy-queue text suffices for KTV machine input).

---

## User Personas

### Primary Persona: The Karaoke Host

**Demographics:**
- Age range: 18–32
- Role: Friend-group organizer, "AUX person"
- Tech savviness: High
- Location: Mobile-first, in a KTV room / living room

**Behaviors:**
- Owns 1+ Spotify playlists (favorites, K-pop, 2000s hits, etc.)
- Shares links via chat apps (WhatsApp / LINE / Telegram)
- Operates under time pressure — people are waiting

**Needs & Motivations:**
- Get a singable shortlist fast without killing the vibe
- Show fairness ("see, it's in all our lists")

**Pain Points:**
- Manually cross-checking playlists is impossible on a phone
- Karaoke machine search is slow and typo-sensitive
- No sense of "which song is safest"

**Quote:** _"Just tell me what we ALL know so we can start singing."_

### Secondary Persona: The Guest Participant

**Demographics:**
- Age range: 16–35
- Role: Friend / party guest
- Tech savviness: Medium
- Location: Same room or remote pre-game

**Behaviors:**
- Has Spotify but may not know playlist URL how-to
- Will paste a link if instructions are 2 taps
- Won't create an account for a party trick

**Needs & Motivations:**
- Be included without installing / logging in
- Veto-proof picks

**Pain Points:**
- "I don't remember what's in my playlist"
- Friction of login / permissions on someone else's phone

**Quote:** _"I'm not logging into anything — just let me drop my playlist link."_

---

## User Stories & Requirements

### Epic: Playlist Overlap Session

#### Must-Have Stories (P0)

##### Story 1: Create session + add playlists via link

**User Story:**
```
As a karaoke host,
I want to create a session and paste 3 Spotify playlist links,
So that I can compare our tastes without anyone logging in.
```

##### Story 1: Create room + guests submit from own phones

**User Story:**
```
As a karaoke host,
I want to show one QR/room code that up to 5 friends scan to submit their own playlist links,
So that nobody copy-pastes, installs, or logs into anything.
```

**Acceptance Criteria:**
- [ ] Given I open the app, when I tap "Start a room", then a room is created (`POST /api/rooms` → `{ code: "KTV-4821" }`) and a QR + code is shown.
- [ ] Given a guest scans the QR (or opens `?room=KTV-4821`), when they paste their public Spotify playlist URL/URI, then it is validated (ID regex `^[A-Za-z0-9]{22}$`) and added to the room as Participant N (max `MAX_PLAYLISTS=5`).
- [ ] Given an invalid / private / malformed / duplicate link, when submitted, then a specific inline error is shown ("Playlist not found or is private…") — not generic.
- [ ] Given each submission, when the Worker fetches it, then the host view live-updates (poll `GET /api/rooms/:code` every 2s) with participant cards (name, # tracks).
- [ ] Given 2+ playlists present, when host taps "Find common songs", then compute runs (client-side match on fetched snapshots) and results render.
- [ ] Single-phone fallback: host can also paste directly into any empty slot on the host view (pass-the-phone, no QR needed).
- [ ] Mobile-first, no login, no install anywhere in the flow.

**Priority:** Must Have (P0)
**Effort:** M (Worker proxy + room endpoints + QR + polling UI)
**Dependencies:** Cloudflare Worker + KV namespace + Spotify app credentials (secret in worker only)

---

##### Story 2: Fetch tracks and compute overlap

**User Story:**
```
As a karaoke group,
I want to see which songs appear in all 5 playlists vs. in 4, 3, or 2 of them,
So that we know the safest vs. backup picks.
```

**Acceptance Criteria:**
- [ ] Given N valid playlists added (2–5), when host taps "Find common songs", then snapshots are fetched via Worker (progress per playlist) and results appear in <10s p95 for ≤500 tracks total.
- [ ] Given fetched tracks, when matching completes, then results are grouped: `In all N (5/5)` → `N-1` → … → `2/N` → pairwise detail when N ≤ 5 (pairs collapse into "more" beyond 10 pairs).
- [ ] Given the same song appears as different Spotify track IDs (remaster, re-record, single vs. album version), when ISRCs match, then they are counted as the same song (ISRC match > ID match fallback, see §Technical).
- [ ] Given normalized title+artist match but different ISRC, when confidence is lower, then show as "likely same" secondary grouping, not merged into primary count (avoid false positives).
- [ ] Given 0 full overlaps, when results render, then empty state says "No songs in all N — here are N-1 and lower near-misses" and still shows partials + similarity score.
- [ ] Each result row shows: title, artist(s), album art thumb, which playlists contain it (chips A�E), duration. (popularity stripped for Dev Mode apps, Spotify Feb-2026 � not shown)

**Priority:** Must Have (P0)
**Effort:** M (matching engine is core complexity)
**Dependencies:** Story 1

---

##### Story 3: Ranked final sing-together list

**User Story:**
```
As a karaoke host,
I want a ranked final song list ordered by likelihood everyone knows it,
So that we sing from the top down.
```

**Acceptance Criteria:**
- [ ] Given results, when ranked, then sort is: `overlapCount DESC, duration ASC (prefer <5min for karaoke)` (popularity stripped for Dev Mode, Feb-2026) — deterministic and documented in UI tooltip.
- [ ] Given ranked list, when I view it, then I see group similarity summary: counts (5/5: X songs, 4/5: Y, 3/5: Z, 2/5: W), Jaccard similarity per pair, overall N-way %.
- [ ] Given the list, when I tap a song, then Spotify deep-link opens (`open.spotify.com/track/{id}`) for preview/verification.
- [ ] Given the list, when I click "Copy queue" then top N titles+artists copy as plain text (`1. Title — Artist`) for pasting into KTV search; success toast shown.
- [ ] List is readable in dark, low-light KTV (high contrast, large tap targets).

**Priority:** Must Have (P0)
**Effort:** S
**Dependencies:** Story 2

---

#### Should-Have Stories (P1)

##### Story 4: Remove / swap a playlist and recompute

```
As a host,
I want to remove or replace one playlist without recreating the session,
So that I can iterate when someone says "use my other playlist".
```
- [ ] Remove participant → results recompute instantly from cached tracks (no refetch).
- [ ] Add replacement → only new playlist fetched.

##### Story 5: (DEFERRED — list-only LOCKED) Export overlap as new Spotify playlist

> LOCKED OUT of MVP per user decision 2026-09-25: output is a copyable list for the KTV machine, not a Spotify playlist. Requires user OAuth + write scopes — out of scope for the no-login MVP. Revisit post-MVP only. Kept here as placeholder so scope is explicit.

##### Story 6: Handoff — guests submit from their own phones (LOCKED primary path)

```
As a guest in the room,
I want to scan one QR and submit my playlist from my own phone in under 20 seconds,
So that we start singing instead of copy-pasting.
```
- [ ] Guest scans host QR → guest view (`?room=CODE`) → pastes own public link → confirmation ("You're in! 3/5 playlists") → can close phone.
- [ ] Host view polls room state (2s) and shows join progress; works on Android + iOS (plain QR + URL, no Share Target required).
- [ ] Fallbacks always available: (a) host pass-the-phone direct paste into empty slot; (b) WhatsApp message → host clipboard-read button.
- [ ] Web Share Target demoted to P1 nicety for the single-phone fallback only (Android Chrome+; iOS unsupported — see §Collection).
- [ ] Target: median guest join time <30s in beta observation.

#### Nice-to-Have Stories (P2)

- P2: Karaoke-availability check (YouTube / karaoke provider search link per song: "Search on YouTube Karaoke").
- P2: Filters: language, explicit toggle, max duration, decade, exclude artists.
- P2: Multiple playlists per person (union per person, then intersect across people).
- P2: "Surprise me" shuffle pick from 3/3 pool.

---

### Functional Requirements

| Req ID | Description | Priority | Status |
|--------|-------------|----------|--------|
| FR-001 | Create room (code + QR) via Worker; guest join via `?room=CODE`; state in KV (TTL ~4h) + localStorage | Must Have | Open |
| FR-002 | Accept 2–5 Spotify public playlist URLs/URIs (MAX_PLAYLISTS=5, raisable to 10), validate ID, reject duplicates/private | Must Have | Open |
| FR-003 | Fetch all tracks per playlist via Worker Spotify proxy (Client Credentials app token, paginated 100/page, CORS enabled) | Must Have | Open |
| FR-004 | Normalize tracks (title, artists, ISRC, duration) and match: Tier 1 Spotify ID, Tier 2 ISRC, Tier 3 normalized title+artists. popularity NOT fetched (stripped for Dev Mode, Feb-2026) | Must Have | Open |
| FR-005 | Group + rank results: overlapCount DESC, duration ASC, title ASC; show N/N, N-1/N … 2/N, pairwise | Must Have | Open |
| FR-006 | Show per-pair Jaccard similarity + counts summary | Must Have | Open |
| FR-007 | Copy queue as text; Spotify track deep-links | Must Have | Open |
| FR-008 | Remove/swap playlist, recompute from cached snapshots (no full refetch) | Should Have | Open |
| FR-009 | (DEFERRED — list-only LOCKED) Save-as-Spotify-playlist | Deferred | Open |
| FR-010 | Room QR + guest join page + host polling; pass-phone + clipboard fallbacks; results-as-QR/text share | Must Have | Open |
| FR-011 | Karaoke search shortcuts, filters, multi-playlist-per-person | Nice to Have | Open |

### Non-Functional Requirements

| Req ID | Category | Description | Target |
|--------|----------|-------------|--------|
| NFR-001 | Performance | Time from "Find" click to results, 5×100-track playlists via Worker proxy | <5s median, <10s p95 |
| NFR-002 | Performance | Page load (vanilla static on Pages), 4G, zero dependencies | LCP <1.5s, total <50 KB |
| NFR-003 | Scalability | Max tracks per playlist handled gracefully | 500 tracks/playlist (paginate; cap with notice beyond); MAX_PLAYLISTS raisable 5→10 via constant |
| NFR-004 | Availability | Static frontend (unlimited) + Worker (100k req/day free); graceful Spotify outage message | Degrade with clear error; demo fixture fallback |
| NFR-005 | Security | Spotify secret in Worker env only, never in bundle; URL allowlist + ID regex; render via textContent | No bundled secret, XSS-safe rendering |
| NFR-006 | Privacy | No logins, no PII; room snapshots in KV with ~4h TTL; "Close room" deletes keys | Ephemeral by construction |
| NFR-007 | Accessibility | WCAG 2.1 AA, keyboard nav, contrast in dark mode | AA, axe clean |
| NFR-008 | Compatibility | Mobile Chrome/Safari + desktop; responsive 360px→desktop | Tested breakpoints |
| NFR-009 | Reliability | Matching determinism: same inputs → same ranking | Unit-tested match engine |

---

## Success Metrics

### Key Performance Indicators (KPIs)

#### Primary Metric (North Star)

**Metric:** Successful overlap sessions per week
**Definition:** # sessions with ≥2 valid playlists added AND results viewed (event `results_viewed`)
**Current Baseline:** 0 (new product)
**Target:** 50 successful sessions in first 4 weeks post-launch (beta with friends + communities); 60%+ `session_started → results_viewed` conversion
**Why This Metric:** Directly captures core value delivered ("we found common songs") — analogous to Spotify's "time spent listening."

#### Secondary Metrics

| Metric | Current | Target | Timeframe |
|--------|---------|--------|-----------|
| Activation rate (started → results viewed) | — | ≥60% | 4 wks |
| Time to results (paste → results) median | — | <120s (includes user paste time) | 4 wks |
| % sessions with ≥1 full (N/N) overlap | — | track baseline (expect 20–40%) | 4 wks |
| Copy-queue / Spotify click-through rate | — | ≥30% of results views | 4 wks |
| Share rate (results link opened on 2nd device) | — | ≥15% | 8 wks |
| Error rate (private/invalid link, Spotify 429/5xx surfaced) | — | <10% of playlist adds | 4 wks |

### Measurement Framework

**Framework Used:** HEART (feature UX quality) + AARRR-lite (activation/referral for viral loop)

- **Happiness:** Post-results micro-survey ("Did you find something to sing?" thumbs up/down) — target ≥70% positive.
- **Engagement:** Songs per results view, copy/expand actions per session.
- **Adoption:** % first-time hosts completing a session without help.
- **Retention:** % hosts creating ≥2 sessions within 14 days (party repeatability).
- **Task Success:** `results_viewed` rate; median paste-to-results time; zero-result handling (partials shown, no dead end).

**AARRR-lite:**
- **Acquisition:** Session link visits (target: track source via `?ref=share`).
- **Activation:** `results_viewed` (aha moment = seeing 3/3 list).
- **Retention:** Repeat host sessions.
- **Revenue:** N/A for MVP (counter-metric: infra cost per session <$0.01).
- **Referral:** Share-link opens, QR scans.

### Analytics Implementation

**Events to Track:**
- `session_started` - host clicks Start
- `playlist_added` - props: `position, track_count, fetch_ms, cached:bool`
- `playlist_add_failed` - props: `reason: invalid|private|not_found|rate_limited|too_large`
- `overlap_computed` - props: `n_playlists, total_tracks, full_overlap_count, partial_count, compute_ms`
- `results_viewed` - props: `full_count, partial_count`
- `queue_copied` / `track_opened_spotify` / `results_shared`
- `feedback_positive` / `feedback_negative`

**Dashboards:** MVP = simple event table + funnel (started → ≥2 adds → computed → viewed → copied). Link TBD (PostHog / Plausible / Vercel Analytics).

---

## Scope

### In Scope

**Phase 1 (MVP — this PRD, LOCKED):**
- Vanilla frontend (`index.html` + `styles.css` + `app.js`) on Cloudflare Pages (unlimited static, free)
- One Cloudflare Worker (`worker.js`, free 100k req/day): Spotify proxy (Client Credentials, secret in env) + room API + CORS
- KV namespace for rooms (TTL ~4h; watch 1k writes/day free cap — keep snapshots browser-side in localStorage, KV for rendezvous only)
- Paste-only flow, 1 playlist per person, 2–5 per room (`MAX_PLAYLISTS=5` → 10 later)
- 3-tier matching (ID → ISRC → normalized title+artist) client-side + ranking + similarity summary
- Output is a ranked list only: copy-queue text + Spotify deep-links (no save-as-playlist)
- Room QR + guest join page + host polling; pass-phone + clipboard fallbacks; no logins anywhere

**Phase 2 (Post-MVP):**
- MAX_PLAYLISTS 5→10; Web Share Target P1 (single-phone fallback nicety; Android-only)
- Filters (explicit, duration, language), karaoke-search shortcuts, results-as-QR share
- Multi-playlist-per-person union; optional WebSocket/Durable-Object live sync if polling proves laggy

### Out of Scope

**Explicitly Excluded:**
- Karaoke audio playback, lyrics, key-change — we output a list, not a player (reason: massive scope; KTV machine owns playback).
- Guaranteed karaoke-catalog availability — we rank by playlist overlap as proxy for "known" (popularity unavailable to Dev Mode apps since Feb-2026) (reason: no single karaoke catalog API).
- Recommendation / "you might also like" ML — deterministic intersection only (reason: trust; users want proof "it's in our lists").
- User accounts / library persistence (reason: friction; KV rooms + localStorage suffice).
- Private playlists (reason: LOCKED paste-only public links; revisit if >30% adds fail as private).
- Save-as-Spotify-playlist (reason: LOCKED list-only; copy-queue text suffices for KTV machine input).
- Frameworks or build steps in frontend (reason: LOCKED vanilla; Worker is one plain JS file, `wrangler.toml` only).

### Future Considerations

- Import via Spotify OAuth picker ("choose from my playlists") as alternative to paste.
- Apple Music / YouTube Music sources (separate APIs, normalization harder).
- Singability scoring (lyrics language match, tempo, vocal range metadata).
- Persistent party rooms with live voting ("upvote tonight's queue").

---

## Technical Considerations

### High-Level Architecture

Vanilla frontend on Cloudflare Pages + one Worker (proxy + rooms). No framework, no build, no database server.

```
[ Host phone ] ──HTTPS──▶ [ Cloudflare Pages: index.html + styles.css + app.js ]
[ Guest phones ] ──scan QR──▶ [ same Pages URL ?room=KTV-4821 ]
        │                            │
        │  vanilla fetch()           │  fetches
        ▼                            ▼
[ Cloudflare Worker: worker.js ] ──Bearer (Client Credentials)──▶ [ Spotify Web API ]
        │  · POST /api/rooms → { code } (KV put, TTL ~4h)
        │  · POST /api/rooms/:code/playlists { playlistUrl } → validate → fetch+paginate → KV put
        │  · GET  /api/rooms/:code → room state (host polls 2s)
        │  · GET  /api/rooms/:code/results → snapshots for client-side match
        │  · adds CORS headers to all responses
        ▼
[ Workers KV: rooms namespace ] (rendezvous only; snapshots ≤25 MiB value cap — fine)
```

**Key decisions (LOCKED v1.7, scrape-first):**
1. **Frontend stays vanilla.** `index.html`, `styles.css`, `app.js` (+ optional `match.js`), zero npm deps, deployed to Cloudflare Pages (push to `main` → auto-deploy, unlimited static requests/bandwidth free).
2. **Worker holds the secret, browser holds nothing.** `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` via `wrangler secret`. Worker mints app token via Client Credentials (`POST accounts.spotify.com/api/token`), caches in-memory until ~55min, proxies `GET /v1/playlists/{id}` + `/tracks?limit=100` with pagination (cap 500 tracks/playlist) and 429/`Retry-After` backoff. No user login exists anywhere in the system — public lists need no token at all (scrape); per-guest OAuth exists ONLY for private playlists.
3. **Rooms, not sessions-on-one-phone.** Room code (`KTV-XXXX`, nanoid-ish) + QR encoding the join URL. Host polls; guests submit once and can close their phones. KV TTL ~4h (a karaoke evening); "Close room" deletes keys.
4. **Matching runs client-side** in `app.js` (pure, deterministic, unit-testable) over snapshots returned by the Worker — keeps Worker CPU far under the 10 ms free limit.
5. **KV write budget respected:** ~6 writes/room (1 room + ≤5 playlist keys) vs. 1,000/day free → ~150 rooms/day headroom. Snapshots additionally cached in browser `localStorage` so re-runs don't re-write.

### Technology Stack

**Frontend (all of it):**
- Vanilla HTML + CSS + JS, no framework, no bundler, no npm. System fonts, hand-written dark-first CSS.
- `app.js` sections (plain `<script>`, no build): `api.js` (Worker fetch), `match.js` (pure matching/ranking), `ui.js` (render host/guest/results), `store.js` (localStorage).
- QR: inline SVG generated by hand-rolled encoder in MVP? No — use a tiny vendored `qrcode.js` single file OR render room code big + copy-link button, QR via free `api.qrserver.com` image (1 line, no dep). Decision: room-code + copy-link day 1, QR image P1-speed (same day, trivial).

**Backend (one file):**
- `worker.js` (~30 lines + helpers) + `wrangler.toml`. Endpoints: `POST /api/rooms`, `POST /api/rooms/:code/playlists`, `GET /api/rooms/:code`, `GET /api/rooms/:code/results`, `DELETE /api/rooms/:code`.
- Spotify client inside worker: token cache (module-scope var), paginate `limit=100&offset`, fields `items(track(id,name,artists(name,id),album(name,images),duration_ms,explicit,external_ids(isrc),is_local)),next,total` (popularity deliberately omitted � stripped for Dev Mode), ≤2 playlists in flight per room, honor 429.
- KV binding `ROOMS`; per-key TTL 14,400s (4h).

**Infrastructure:**
- Hosting: Cloudflare Pages (frontend) + Workers (free 100k req/day) + KV (free 100k reads/1k writes/day, 1 GB).
- Secrets: `wrangler secret put SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET` — never in repo (CI grep check).
- Analytics: deferred MVP (count rooms via KV key count + Pages traffic); privacy-friendly pixel post-MVP.

### API Requirements (Worker)

- `POST /api/rooms` → `{ code, joinUrl }` (creates `{ code, createdAt, participants: [] }`, TTL 4h)
- `POST /api/rooms/:code/playlists` — body `{ playlistUrl }` → `{ participantId, playlistId, name, owner, trackCount, image }` or error `{ code: INVALID_URL | NOT_FOUND | PRIVATE | TOO_LARGE | RATE_LIMITED | ROOM_FULL, message }`
- `GET /api/rooms/:code` → `{ code, participants: [{…preview, trackCount}], trackCounts }` (lightweight poll payload; NOT full snapshots)
- `GET /api/rooms/:code/results` → `{ snapshots: NormalizedTrack[][], computedAt }` (full data for client match)
- `DELETE /api/rooms/:code` → purge room + playlist keys

**Spotify (worker → Spotify, never browser):**
- `POST https://accounts.spotify.com/api/token` (grant_type=client_credentials, Basic ID:SECRET)
- `GET /v1/playlists/{id}` + `GET /v1/playlists/{id}/tracks?...` paginated as above.

**Scopes:** none (app-only public data). No OAuth, no user tokens, no login — anywhere.

### Matching Engine (core logic — must be unit-tested)

Normalize each track → `NormalizedTrack { spotifyId, isrc, titleNorm, artistNorm, artists[], durationMs, image, explicit, popularity: 0 (shape-compat) }`.

- `titleNorm`: lowercase, trim, strip `(remastered.*)`, `- remaster`, feat. variants moved to artists; unicode NFKD; collapse whitespace.
- `artistNorm`: sorted lowercased artist names joined by `&`.

Match tiers per candidate group:
1. **Tier 1 — Spotify ID:** same `spotifyId` → merge, confidence `exact`.
2. **Tier 2 — ISRC:** same `isrc` (non-null) → merge, confidence `exact-version-family`. This catches remasters / single-vs-album duplicates.
3. **Tier 3 — Title+Artist:** same `(titleNorm, artistNorm)` with different IDs/ISRCs → group as `likely_same`, shown separately, NOT counted in headline 3/3 number (prevents false "everyone knows this" claims).

Grouping: build map across all participants; each merged song records `presentIn: [participantIds]`, `overlapCount = presentIn.length`. Dedup *within* a playlist first (same playlist containing duplicates counts once per participant).

Ranking: `overlapCount DESC -> min(durationMs) ASC -> titleNorm ASC`. popularity excluded (stripped for Dev Mode, Feb-2026).

Similarity: pairwise Jaccard `|A∩B| / |A∪B|` using Tier1+2 merges; overall `|∩ all| / |∪ all|`. Counts shown as integers + %.

Edge handling: local/unavailable tracks (`is_local`, `track == null`) skipped with count surfaced ("3 unavailable tracks skipped"); playlists >500 tracks capped with notice + first-500 analyzed (document limitation); `popularity` not requested (always stripped for Dev Mode); no instrumental flag in MVP.

### Security Requirements

- **Authentication:** None for users. Worker-to-Spotify uses Client Credentials (secret in Worker env, in-memory token cache ~55min).
- **Authorization:** Room codes unguessable (`KTV-` + 4 chars from CSPRNG); no room enumeration endpoint.
- **Data Encryption:** TLS via Cloudflare defaults; secrets via `wrangler secret`, never in repo (CI grep for `client_secret|spotify.*secret`).
- **Compliance:** No PII collected; playlist names/owners are public Spotify data cached ~4h. "Close room" purges KV keys.
- **Input hardening:** URL allowlist (`open.spotify.com|spotify:`), ID regex `^[A-Za-z0-9]{22}$`, length ≤500; render via `textContent`, never `innerHTML`; per-IP rate cap on `POST /playlists` (e.g., 30/10min in Worker).

### Performance Requirements

- **Response Time:** Compute p95 <10s for 5×100 tracks via Worker (Spotify fetch dominates; skeleton + per-playlist progress). Poll interval 2s; results fetch once.
- **Throughput:** Worker free 100k req/day ≈ 4,000+ sessions/day; Pages static unlimited.
- **Concurrency:** 1 host polling + ≤5 guests submitting; last-write-wins per slot; no locks.
- **Database:** None — KV rendezvous only. Room key + ≤5 playlist keys, TTL 14,400s.
- **Caching:** Playlist snapshots in browser `localStorage` 24h (`kc:pl:{id}`) + KV 4h; Spotify app token in Worker memory ~55min; client memoizes compute per playlist-ID set.

### Scalability

- **Expected Load:** Beta: 10s of sessions/week — free tiers idle.
- **Growth Projections:** KV writes (1k/day → ~150 rooms/day) is the first cap hit; mitigations: browser `localStorage` snapshots avoid re-fetch writes, 4h TTL, "Close room" deletes. Next cap: Worker 100k req/day ($5/mo → 10M).
- **Scaling Strategy:** None needed for MVP. If polling proves chatty, batch poll payload (already light) or move to Durable Objects WebSocket post-MVP.

### Data Considerations

**Data Model (KV rendezvous + browser cache):**
- `Room { code, createdAt, participantIds[0..5], version }` → KV `room:{code}`, TTL 14,400s
- `Participant { slot, playlistId, playlistName, owner, image, trackCount, addedAt }` → KV `room:{code}:pl:{slot}`
- `TrackSnapshot { playlistId, fetchedAt, tracks: NormalizedTrack[] }` → KV same key (value ≤25 MiB — fine) + browser `kc:pl:{id}`
- `MatchResult { songKey, title, artists, image, durationMs, presentIn[], confidence }` — computed client-side, never stored

**Storage Requirements:** ~1–2 KB/track JSON → 500-track playlist ~1 MB; KV 1 GB free cap irrelevant at this scale.

**Data Migration:** N/A (TTL-ephemeral schema; version prefix `room:v1:`).

**Privacy & Compliance:**
- PII handling: none. Public Spotify data cached ~4h in KV + 24h in guest/host browsers.
- Data deletion: `DELETE /api/rooms/:code` purges room + playlist keys immediately; TTL auto-purges the rest.
- Audit logging: Worker logs playlist IDs + error codes only (no IPs beyond Cloudflare defaults).

---

## Design & UX Requirements

### User Experience Principles

- **2-minute party trick:** 3 steps max; every state fits a phone held one-handed in the dark.
- **Proof, not magic:** always show *which* playlists contain each song (chips) — trust is the product.
- **No dead ends:** zero full-overlaps still yields partials + next actions.

### User Flows

**Primary Flow (multi-device, LOCKED v1.2):**
1. Host opens Pages app → "Start a room" → Worker returns code (`KTV-4821`) → host view shows QR + big code + `?room=KTV-4821` link.
2. Each guest scans QR with their camera → guest view opens on their phone → pastes own Spotify link → "You're in!" → can pocket phone.
3. Host view polls room (2s) → participant cards fill in (name, # tracks, progress) → at 2+ playlists "Find common songs" enables.
4. Host taps → Worker snapshots fetched → client-side match → ranked N/N → 2/N results → copy queue / Spotify links. Optional: results-as-text QR for guests to photograph.

### Link Collection Methods (5 people, 1 room — ranked)

Room-QR (Method 1) is the LOCKED primary path. Everything else is fallback. No backend-sync-free QR-collection paradox anymore — the Worker IS the sync.

| # | Method | Guest steps | Host steps | Time/guest | Verdict |
|---|--------|-------------|------------|------------|---------|
| 1 | **Room QR → guest submits from own phone (LOCKED primary)** | Scan QR → paste own link → done | Show QR, watch joins land | ~20s | **MVP day 1.** Works Android + iOS (plain camera + URL). Zero installs, zero logins, zero copy-paste across people. |
| 2 | **Room code manual entry** | Type `yourapp.pages.dev`, enter 8-char code, paste link | Read code aloud | ~30s | **Day-1 fallback** for broken cameras / no-QR situations. Same guest page, code field on landing. |
| 3 | **Pass-the-phone direct paste** | Spotify → Share → Copy → paste into host's open slot | Hand phone over | ~15s | **Day-1 fallback.** Zero infra; socially fine at karaoke. Host slots accept direct paste alongside room joins. |
| 4 | **WhatsApp → host clipboard-read** | Share link to host chat | Tap "paste from clipboard" per message | ~60-90s | **Universal last resort.** `navigator.clipboard.readText()` button (permission-guestd). |
| 5 | **Web Share Target (per-slot receive)** | Spotify → Share → app in sheet | Pre-installed PWA | ~10s | **P1 nicety, single-phone fallback only.** Android Chrome/Edge 89+ only; iOS Safari unsupported (WebKit bug open); requires PWA install first; one `share_target` per manifest. Not the core flow. |

**UX details:** guest page is one input + one button + inline validation; host view shows slots (empty → joining → N tracks ✓ / error) with per-slot remove; `inputmode="url"`, `autocomplete="off"`; per-slot "how to share from Spotify" 3-step hint.

**Alternative Flows:**
- Invalid/private link → inline error + "how to make public" hint (Spotify: playlist ••• → Make public → Copy link).
- 0 full overlaps → "No 3/3 — start with these 2/3 bangers" + similarity insight ("A & B are 34% similar, C is the outlier").
- Playlist too large (>500) → notice "Analyzed first 500 tracks" + suggest splitting.

### Visual Design

**Design Assets:** None required (hand-written vanilla CSS, system fonts, dark-first).
**Key Screens:** (1) Landing (start room / enter code), (2) Host room (QR + slots + poll), (3) Guest join (1 input), (4) Fetching progress, (5) Results (grouped + summary), (6) Error/empty states.
**Design System Components:** Cards, chips (playlist A–E color-coded), sticky "Find" CTA, skeleton loaders, toast, QR/code display.

### Interaction Patterns

- Paste → instant playlist preview card (artwork + name + count) before compute.
- Sticky bottom CTA on mobile ("Find common songs (3)").
- Expandable pairwise sections (A∩B etc.) collapsed by default.
- Copy-queue button sticky on results; toast confirm.

### Accessibility (a11y)

**Requirements:**
- WCAG 2.1 Level AA; visible focus; 4.5:1 text contrast (dark bg tested).
- All inputs labeled; errors announced via `aria-live`.
- Touch targets ≥44px (KTV one-handed use).

**Testing:**
- [ ] Keyboard-only flow test (paste → compute → copy)
- [ ] Screen reader pass (NVDA/VoiceOver) on results grouping
- [ ] Contrast verification (dark theme)
- [ ] axe / Lighthouse a11y ≥90

### Responsive Design

**Breakpoints:** Mobile 360–767 (primary), Tablet 768–1023, Desktop 1024+.
**Platform-Specific:** Mobile Safari paste + sticky CTA tested; desktop shows 2-col results + summary sidebar. No native apps in MVP.

---

## Timeline & Milestones

**Target Launch Date:** MVP beta ~3 weeks from kickoff (solo dev, part-time assumption — adjust if full-time).

| Phase | Deliverables | Owner | Start | End |
|-------|-------------|-------|-------|-----|
| **Discovery** | This PRD v1.2 approved (Cloudflare locked); Spotify app created; `wrangler secret` set; room-QR flow locked | PM/Eng | W0 | W0+3d |
| **Design** | Host / guest / results vanilla CSS prototypes; copy + error strings; QR + code UX | Design/Eng | W1 | W1 end |
| **Development** | `index.html` + `styles.css` + `app.js` (Pages) + `worker.js` + `wrangler.toml`; Pages + Worker deploy | Engineering | W1 | W2 end |
| **QA** | Unit tests (match tiers, ranking via `node --test`), 10 playlist fixtures via Worker, iOS + Android QR join pass, a11y | Eng | W3 start | W3 mid |
| **Beta** | 10–15 real karaoke groups; activation + guest-join-time observation | PM | W3 mid | W4 |
| **Launch** | Public Pages link; post-launch review | PM/Eng | W4 | W4 end |

### Key Milestones

- Kickoff + Worker→Spotify proxy returning tracks from Pages origin (Day 3)
- First end-to-end 5-phone room join + overlap on staging (End W1)
- Matching engine tests green incl. ISRC/remaster fixtures (W2)
- Beta with real groups incl. join timing (W3)
- GA MVP (W4)

---

## Risks & Mitigation

| Risk | Impact | Probability | Mitigation Strategy | Owner |
|------|--------|------------|---------------------|-------|
| Spotify API 429 / outage mid-party | High | Medium | Worker backoff + honor Retry-After; KV snapshots survive re-runs; clear "Spotify is slow, retry" state; demo fixture fallback | Eng |
| >30% playlists are private → add failures | High | Medium | Inline "make public" guide with screenshots; count failure reasons; revisit only post-MVP | PM/Eng |
| KV write cap (1k/day) hit during spike | Medium | Low | Browser localStorage snapshots avoid re-fetch writes; 4h TTL; "Close room" deletes; upgrade path $5/mo documented | Eng |
| False merges (wrong songs counted as same) erode trust | High | Medium | Tier 3 never inflates headline count; show confidence; unit fixtures for remasters/covers/parodies | Eng |
| Zero full overlaps disappoints ("useless") | Medium | High | Design empty state around N-1 and lower near-misses + similarity + shuffle-pick CTA; set expectation in copy ("even 2/5 saves 20 min") | Design/PM |
| Same song, different language versions / covers missed | Medium | High | Document as limitation; Phase 2: optional title+artist fuzzy toggle + explicit "covers excluded" note | Eng |
| Karaoke machine doesn't have top songs | Medium | High | Copy-queue text for manual search + YouTube-karaoke shortcut (P2); never claim availability | PM |
| Room code guessed / griefed | Low | Low | CSPRNG codes, no enumeration, 4h TTL, host can close + reopen | Eng |

### Contingency Plans

**If Worker free caps hit (100k req/day or KV writes):**
- Action: enable browser-snapshot-first path (skip Worker re-fetch when `localStorage` fresh); then upgrade to Workers Paid ($5/mo → 10M req).
- Decision maker: Eng. Trigger: Cloudflare dashboard alerts at 80%.

**If matching quality complaints >20% negative feedback:**
- Action: tighten Tier 3 (require duration within ±7s + same explicit flag); add "report wrong merge" event.
- Trigger: `feedback_negative` with reason `wrong_merge`.

---

## Dependencies & Assumptions

### Dependencies

**Internal:**
- [ ] Spotify app created; `wrangler secret put SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET` set
- [ ] Cloudflare account: Pages project + Worker + KV namespace (`ROOMS`) bound
- [ ] (No analytics infra in MVP — room counts via KV + Pages traffic)

**External:**
- [ ] Spotify Web API availability + rate limits (worker-side, app token)
- [ ] Users provide *public* playlists (or accept make-public step)

### Assumptions

- MVP supports 2–5 playlists (`MAX_PLAYLISTS=5`, raisable to 10); 1 playlist per person. Multi-per-person is P2 union.
- Room flow: host QR/code → guests join from own phones; pass-phone + code-entry + clipboard fallbacks included.
- Output is a ranked list only (copy-queue text for KTV input); no save-as-playlist.
- Vanilla frontend + Cloudflare Pages; one Worker file; KV TTL 4h; $0 infra.
- "Understood/sung by everyone" is proxied by *playlist co-occurrence alone (popularity stripped for Dev Mode)* — not by lyrics knowledge testing or karaoke catalog.
- Playlists are reasonable size (≤500 tracks analyzed; beyond capped with notice).
- Mobile browser is primary context (KTV / party); desktop is secondary.
- No user accounts, no stored personal data, ephemeral sessions acceptable for beta trust.

---

## Open Questions

- [x] **Paste-links vs. OAuth picker for MVP? — DECIDED: paste-only.** No user OAuth anywhere; Worker uses app-only Client Credentials.
- [x] **Max playlists? — DECIDED: 5 for MVP (`MAX_PLAYLISTS=5`), raisable to 10 later**; 1 playlist per person.
- [x] **Save-as-Spotify-playlist in MVP or Phase 2? — DECIDED: neither; list-only.** Copy-queue text suffices for KTV.
- [x] **Stack/deploy? — DECIDED v1.2: vanilla frontend on Cloudflare Pages + Worker proxy + KV rooms.** GitHub Pages dropped (no secret storage, no sync).
- [x] **Collection method? — DECIDED: room QR primary; code-entry + pass-phone + clipboard fallbacks day 1; Share Target P1 nicety.**
- [x] **Spotify token / login? — DECIDED: nobody logs in.** Worker mints app token with its own secret; guests use their own Spotify apps only to copy links.
- [ ] **How strict should Tier-3 (title+artist) merging be?**
  - **Context:** Covers/remixes share titles; false positives damage trust.
  - **Options:** (a) Exclude from headline counts (recommended, this PRD), (b) Include with confidence badge.
  - **Owner:** Eng — **Deadline:** Matching implementation.
- [ ] **Polling (2s) vs. Durable Objects WebSocket for host live-updates?**
  - **Context:** Polling is free-tier-safe and trivial; WebSocket is smoother but adds cost/complexity.
  - **Options:** (a) 2s polling MVP (recommended), (b) Durable Objects if beta shows lag complaints.
  - **Owner:** Eng — **Deadline:** Beta review.
- [ ] **Do we need karaoke-availability signals (YouTube/KTV search links)?**
  - **Context:** Overlap ≠ available at venue.
  - **Options:** P2 shortcut links (recommended) vs. deeper catalog integration (deferred).
  - **Owner:** PM — **Deadline:** Beta review.

---

## Stakeholder Sign-Off

| Stakeholder | Role | Review Status | Approved | Date |
|------------|------|---------------|----------|------|
| TBD | Product Lead | ⏳ Pending | ☐ | - |
| TBD | Engineering Lead | ⏳ Pending | ☐ | - |
| TBD | Design Lead | ⏳ Pending | ☐ | - |
| TBD | QA | ⏳ Pending | ☐ | - |

---

## Appendix

### References

- Spotify Web API: Get Playlist, Get Playlist Items, Client Credentials flow (worker-side app token; no user login)
- Cloudflare: Pages (static hosting), Workers (proxy + room API; free 100k req/day, 10 ms CPU), KV (rooms; free 100k reads / 1k writes / day, 1 GB), CORS proxy pattern
- Web Share Target: Chrome/Android-only, iOS unsupported — P1 nicety, not core flow
- Skill refs: `prd_template.md`, `user_story_examples.md` (Given-When-Then AC), `metrics_frameworks.md` (HEART + AARRR-lite, North Star)

### Related Documents

- Scaffold (this session): `karaoke-buddy/index.html` + `styles.css` + `app.js` + `worker.js` + `wrangler.toml` (worker name `karaoke-buddy`)
- Matching fixtures: remaster vs. original (same ISRC), single vs. album, cover (same title, different artist — must NOT merge), parody title

### Glossary

- **Room (e.g., KTV-4821):** KV-backed rendezvous (TTL ~4h) holding ≤5 playlist snapshots; host polls, guests submit once.
- **N/N overlap (e.g., 5/5):** Track present in all N playlists (Tier 1+2 merges only for headline count).
- **Partial overlap (e.g., 3/5):** Track present in subset; backup picks.
- **ISRC:** International Standard Recording Code — identifies a recording; same song remaster often shares ISRC family.
- **Jaccard similarity:** |A∩B| / |A∪B| — taste similarity between two playlists.
- **MAX_PLAYLISTS:** Single constant (5 in MVP, 10 later) bounding slots, fetch budget, and pairwise UI.
- **App token (Client Credentials):** Worker-held Spotify auth for public data — no user login involved.

### Change Log

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-09-25 | PM (AI) | Initial Technical PRD from karaoke idea |
| 1.1 | 2026-09-25 | PM (AI) | Locked decisions: paste-only, max 5 (→10 later), list-only, vanilla static + GitHub Pages; rewrote Technical section (no backend); added §Collection ranking (pass-phone default, Share Target P1, WhatsApp fallback); resolved 4 Open Questions |
| 1.2 | 2026-09-25 | PM (AI) | Switched to Cloudflare Pages + Worker proxy + KV room-sync; room-QR primary flow (no logins anywhere); Share Target → P1; resolved token/login questions; scaffold added |

---

## Self-Review Checklist (prd-generator Step 5)

- [x] **Problem is clear:** karaoke groups can't find mutually-known songs; current manual flow documented.
- [x] **Users are identified:** Host (primary) + Guest (secondary) with behaviors and quotes.
- [x] **Success is measurable:** North Star (successful overlap sessions) + HEART/AARRR targets + event spec.
- [x] **Scope is bounded:** MVP locked (paste-only, 5-max, list-only, vanilla Pages + Worker + KV rooms); OAuth, save-as-playlist, WS sync deferred with reasons.
- [x] **Requirements are testable:** Given-When-Then AC per P0 story; FR/NFR tables with targets.
- [x] **Timeline is realistic:** 3-week MVP with phases; solo/small-team assumption stated.
- [x] **Risks are identified:** Spotify limits, private links, false merges, zero-overlap, availability gap with mitigations.
- [x] **Stakeholders aligned:** Sign-off table pending — needs human review (see Open Questions).

> Validation script (`scripts/validate_prd.sh`) not run — Windows workspace without bash; manual checklist above applied instead. Run `./scripts/validate_prd.sh karaoke-consensus-technical-prd.md` on macOS/Linux CI if needed.
