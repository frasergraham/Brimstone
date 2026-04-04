# Admin Panel Redesign

## Progress Status

### Completed (server-side)
- `server/auth.js` — Exported `setAdmin(playerId, isAdmin)` function
- `server/admin.js` — Added `getAllGamesPaginated()`, `getAllPlayersDetailed()`, `getGameDetail()`
- `server.js` — Added 4 new API endpoints, removed `/debug/players` route, added redirects for old admin URLs, updated imports

### Completed (client-side)
- `admin.html` — Full rewrite as consolidated single-page admin panel with 5 tabs
- `admin-stats.html` — Deleted
- `admin-campaign-stats.html` — Deleted
- `tests/admin-access.test.js` — Updated to check single admin file, added setAdmin toggle tests
- `npm test` — 1275/1276 pass (1 pre-existing mobile-responsive failure)

---

## Context

The admin functionality is fragmented across 3 HTML files (`admin.html`, `admin-stats.html`, `admin-campaign-stats.html`) with ~275 lines of duplicated CSS each. There's also an unauthenticated `/debug/players` route exposing sensitive data. The goal is to consolidate everything into a single admin page, add paginated game browsing with detail views, allow admin role management, and adopt a functional monospace style decoupled from the game's gothic theme.

---

## Tab Structure (5 tabs)

| Tab | Content | API Source | Auto-refresh |
|-----|---------|------------|-------------|
| **Dashboard** | Stats bar + active games table + spectate buttons | `/admin/api/stats` + `/admin/api/rooms` | 10s |
| **All Games** | Paginated table of ALL games (active/saved/completed MP/SP) with source filter. Click row for inline detail with turn history + spectate/replay. | `/admin/api/all-games` + `/admin/api/game-detail/:id` | No |
| **Players** | Player table with admin toggle, expandable rows showing identities + device tokens (absorbs debug route) | `/admin/api/players/detail` | No |
| **Balance** | Summary cards, faction balance meter, win conditions, map sizes, unit economy, version breakdown, AI matchups | `/admin/api/game-stats/summary` | No |
| **Campaign** | Campaign summary, per-mission breakdown, win conditions, sessions, unit economy | `/admin/api/campaign-game-stats/summary` | No |

---

## New Server API Endpoints (DONE)

### `GET /admin/api/all-games?page=1&limit=50&source=all|active|saved|completed_mp|completed_sp`
Server-side paginated endpoint using `UNION ALL` across `game_saves`, `completed_games`, `sp_completed_games`. Active in-memory games (from `getRooms()`) prepended to page 1. Returns `{ games[], total, page, limit }`.

### `GET /admin/api/game-detail/:id?source=active|saved|completed_mp|completed_sp`
Full game detail with turn history. Dispatches based on `source`:
- `active` -> `getRoom()` + `getRoomChronicle()`
- `saved` -> `getSaveWithState()` + `getSaveRounds()`
- `completed_mp` -> `getCompletedGame()` + `getCompletedGameRounds()`
- `completed_sp` -> `getSpCompletedGame()` + `getSpCompletedGameRounds()`

Returns `{ game, rounds[], canSpectate }`.

### `POST /admin/api/players/:playerId/admin`
Toggle admin status. Body: `{ isAdmin: boolean }`. Prevents self-de-admin.

### `GET /admin/api/players/detail`
Extended player data with identities + device tokens (replaces `/debug/players`).

---

## Files Modified (server-side — DONE)

| File | Change |
|------|--------|
| `server.js` | Added 4 new endpoints, redirect `/admin/stats` + `/admin/campaign-stats` to `/admin`, **removed** `/debug/players` route, updated imports |
| `server/admin.js` | Added `getAllGamesPaginated()`, `getAllPlayersDetailed()`, `getGameDetail()` |
| `server/auth.js` | Exported `setAdmin(playerId, isAdmin)` wrapper around existing `_setAdmin` prepared statement |

## Files To Modify (client-side — TODO)

| File | Change |
|------|--------|
| `admin.html` | **Complete rewrite** — single-page admin with 5 tabs, monospace dark theme |
| `tests/admin-access.test.js` | Update to check single admin file, add admin toggle tests |

## Files To Delete (after admin.html rewrite)

- `admin-stats.html`
- `admin-campaign-stats.html`

---

## Key Design Decisions

1. **Single HTML file** — consistent with project convention (no build step). All CSS/JS inline. ~900-1100 lines total.
2. **Monospace dark theme** — derived from debug page (`#1a1a2e` bg, monospace font, `#333` borders, `#7af` accent). NOT the game's gothic serif theme.
3. **Desktop-only** — no mobile responsive styles needed.
4. **Game detail as inline expansion** — click a table row to expand a detail panel below it (no separate page). Shows metadata, turn history with timestamps, spectate/replay/activate buttons.
5. **Server-side pagination** — `LIMIT/OFFSET` on `UNION ALL` query. Active games always prepended to page 1 (small set, always in-memory).
6. **Admin toggle** — simple button in Players table. Cannot remove own admin. Uses existing `_setAdmin` prepared statement.
7. **Debug route absorbed** — player identities + device tokens shown in Players tab expandable rows. `/debug/players` removed.

---

## admin.html Architecture

### CSS Theme (monospace dark, ~200 lines)

```css
:root {
  --bg:          #1a1a2e;
  --bg-panel:    #1e1e3a;
  --bg-section:  #22224a;
  --border:      #333;
  --text:        #eee;
  --text-dim:    #999;
  --text-bright: #fff;
  --accent:      #7af;
  --accent-dim:  #58a;
  --hero:        #d4a72c;
  --witch:       #9b59b6;
  --green:       #4caf7d;
  --red:         #c0392b;
  --yellow:      #e0c030;
  --font:        monospace;
}
```

All text uses `font-family: monospace`. Tables use `border: 1px solid #333`. Buttons are simple bordered rectangles. No mobile responsive styles.

Key CSS classes to port/merge:
- From admin.html: `.stats-bar`, `.stat-box`, `.tabs`, `.tab-btn`, `.badge`, `.btn`, `.id-short`, `.time-ago`
- From admin-stats.html: `.cards`, `.card`, `.section`, `.bar-row`, `.bar-track`, `.bar-fill`, `.bar-value`, `.bar-label`, `.balance-meter`, `.health-badge`, `.note`, `.empty-state`

### HTML Skeleton

```html
<div class="admin-wrap">
  <header>BRIMSTONE ADMIN + version</header>
  <div class="stats-bar">...4 stat boxes...</div>
  <nav class="tabs">
    <button data-tab="dashboard">Dashboard</button>
    <button data-tab="games">All Games</button>
    <button data-tab="players">Players</button>
    <button data-tab="balance">Balance</button>
    <button data-tab="campaign">Campaign</button>
  </nav>
  <div id="tab-dashboard" class="tab-content active">
    <!-- Active games table with spectate buttons -->
  </div>
  <div id="tab-games" class="tab-content">
    <!-- Source filter dropdown + paginated games table -->
  </div>
  <div id="tab-players" class="tab-content">
    <!-- Players table with admin toggle + expandable detail rows -->
  </div>
  <div id="tab-balance" class="tab-content">
    <!-- Rendered by loadBalanceStats() -->
  </div>
  <div id="tab-campaign" class="tab-content">
    <!-- Rendered by loadCampaignStats() -->
  </div>
</div>
```

### JavaScript Architecture (~700 lines)

**Auth gate** (~15 lines):
- Read `brimstone_session` from localStorage
- Check `/api/me/admin`, redirect if not admin

**Shared helpers** (~60 lines):
- `api(path)` — fetch with auth token, redirect on 401/403
- `apiPost(path, body)` — POST with auth token
- `timeAgo(unixSeconds)`, `formatUptime(seconds)`, `shortId(id)`, `_esc(str)`
- `pct(n, total)`, `fmtDuration(ms)`
- `balanceBadge(pct)`, `roundsBadge(avg)`, `winRateBadge(pct)` — health badges
- `card(value, label, cls)`, `barRow(label, count, max, color, suffix)` — HTML builders

**Tab system** (~20 lines):
```js
const _tabLoaded = {};
function switchTab(tabId) {
  // Toggle active classes on buttons and content divs
  // If !_tabLoaded[tabId], call loadTabData(tabId), mark loaded
  // Start/stop dashboard auto-refresh based on active tab
}
```

**Dashboard tab** (~80 lines) — port from current admin.html:
- `loadStats()` — populates stats bar
- `loadRooms()` — populates active games table with spectate buttons
- `spectateRoom(roomId)` — opens `/spectate?room=...` in new tab
- Auto-refresh: `setInterval` every 10s, only fires when Dashboard is active tab

**All Games tab** (~120 lines) — NEW:
- Source filter `<select>`: All, Active, Saved, Completed (MP), Completed (SP)
- Page navigation: `Prev | Page X of Y | Next`
- Table columns: Source, Hero, Witch, Round/Status, Winner, Mode, Date
- `loadAllGames(page, source)` — calls `/admin/api/all-games`
- Row click: `toggleGameDetail(id, source)` — inserts/removes detail `<tr>` below clicked row
- Detail row fetches `/admin/api/game-detail/:id?source=...` and shows:
  - Metadata: players, round, phase, winner, win_reason, mode, version, timestamps
  - Actions: Spectate (active), Activate (saved), Replay (completed)
  - Turn history: list of rounds with round number and timestamp

**Players tab** (~80 lines) — port + enhance:
- `loadPlayersDetailed()` — calls `/admin/api/players/detail`
- Table columns: Username, ID (short), Identities, Wins, Losses, Draws, Win%, Admin, Joined
- Admin column: toggle button (lit "ADMIN" badge or dim "grant" button)
- Cannot remove own admin (button disabled)
- Row click: `togglePlayerDetail(playerId)` — shows identities, device tokens, full UUID, token prefix
- `toggleAdmin(playerId, currentIsAdmin)` — calls `POST /admin/api/players/:id/admin`

**Balance tab** (~100 lines) — port from admin-stats.html `render()`:
- `loadBalanceStats()` — calls `/admin/api/game-stats/summary`
- `renderBalance(data)` — builds summary cards, faction balance meter, game length, win conditions bar charts, map sizes, game modes, unit economy table, version breakdown, AI personality matchups
- Same render logic as admin-stats.html minus the campaign section at the bottom

**Campaign tab** (~80 lines) — port from admin-campaign-stats.html `render()`:
- `loadCampaignStats()` — calls `/admin/api/campaign-game-stats/summary`
- `renderCampaign(data)` — builds campaign summary cards, win rate meter, per-mission breakdown, win conditions, campaign sessions, unit economy, recent games
- Same render logic as admin-campaign-stats.html

**Init** (~15 lines):
- Wire tab click handlers
- Load Dashboard data on page load
- Start auto-refresh interval

---

## Implementation Sequence for admin.html

Write the file in this order:

1. `<!DOCTYPE html>` through end of `</style>` — CSS block with monospace dark theme
2. `<body>` through `</body>` — HTML skeleton with all 5 tab containers
3. `<script>` section 1 — Auth gate + shared helpers + tab system
4. `<script>` section 2 — Dashboard tab (loadStats, loadRooms, spectateRoom, auto-refresh)
5. `<script>` section 3 — All Games tab (loadAllGames, toggleGameDetail, pagination)
6. `<script>` section 4 — Players tab (loadPlayersDetailed, togglePlayerDetail, toggleAdmin)
7. `<script>` section 5 — Balance tab (loadBalanceStats, renderBalance) — port from admin-stats.html
8. `<script>` section 6 — Campaign tab (loadCampaignStats, renderCampaign) — port from admin-campaign-stats.html
9. `<script>` section 7 — Init (wire handlers, load dashboard, start interval)

---

## Verification

1. `npm test` — all tests pass
2. Navigate to `/admin` — see 5 tabs with monospace dark theme
3. Dashboard auto-refreshes, spectate buttons work
4. All Games shows paginated list with source filter, page nav, inline detail expansion
5. Click active game detail -> spectate button opens new tab
6. Click completed game detail -> see round history, replay link works
7. Players tab shows admin toggle, expanding a row shows identities + device tokens
8. Toggle admin on a player — status changes; cannot de-admin self
9. Balance + Campaign tabs render all stats from the old pages
10. `/admin/stats` and `/admin/campaign-stats` redirect to `/admin`
11. `/debug/players` no longer accessible
12. Non-admin users redirected to `/` on visiting `/admin`
