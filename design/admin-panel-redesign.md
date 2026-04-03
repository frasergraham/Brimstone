# Admin Panel Redesign + Spectate Bug Fix

## Problem

### Spectate Bug
Clicking "Spectate" on an active game in the admin panel always shows "Admin access required" even for admins. 

**Root cause:** `initSpectator()` in `src/main.js` creates a fresh WebSocket and immediately sends `adminSpectateRoom` on open — without authenticating first. The server checks `cs.player?.is_admin` but `cs.player` is null because no `auth` message was sent on this new socket connection.

**Fix (done):** Read session from localStorage, send `{ type: 'auth', token }` on WebSocket open, wait for `authOk` response, then send `adminSpectateRoom`. Handle missing session and auth errors gracefully.

### Admin Panel Fragmentation
The admin panel is split across 3 separate HTML files with ~275 lines of duplicated CSS each:
- `admin.html` (640 lines) — Dashboard with live stats, 4 tabs (Active Games, Saved Games, Completed Games, Players)
- `admin-stats.html` (618 lines) — Balance analysis, win conditions, map sizes, personality matchups
- `admin-campaign-stats.html` (458 lines) — Campaign-specific stats and progression

Navigation between pages is clunky (full page loads, separate auth gates each time). CSS is copy-pasted across all three.

---

## Design: Consolidated Single-Page Admin Panel

### Tab Structure

| Tab | Content | API Endpoints | Auto-refresh |
|-----|---------|--------------|--------------|
| **Dashboard** | Server stats bar (connections, rooms, queue, uptime) + Active Games table with Spectate buttons | `/admin/api/stats`, `/admin/api/rooms` | Every 10s |
| **Games** | Sub-tabs: Saved Games, Completed Online, Completed SP. Activate/Replay buttons | `/admin/api/saves`, `/admin/api/completed-games`, `/admin/api/sp/completed-games` | No |
| **Players** | Player list with W/L/D/Win% stats | `/admin/api/players` | No |
| **Balance** | Summary cards, faction balance meter, game length analysis, win conditions bar charts, map size distribution, game mode distribution, unit economy table, version breakdown, AI personality matchups | `/admin/api/game-stats/summary` | No |
| **Campaign** | Campaign summary cards, win rate meter, per-mission breakdown, win conditions, campaign sessions, unit economy, recent campaign games | `/admin/api/campaign-game-stats/summary` | No |

### Key Design Decisions
- **Spectate opens in new browser tab** (preserves admin panel state while watching game)
- **Lazy-loading tabs** — data fetched on first tab activation, not all at page load
- **Auto-refresh scoped to Dashboard** — only polls server when Dashboard tab is active
- **Single auth gate** — one check on page load instead of three separate pages
- **Unified CSS** — one block merging all styles, no duplication

### CSS Architecture
Merge into single `<style>` block:
- **From admin.html:** stats-bar, tabs, badges, buttons, player-list, id-short, time-ago
- **From admin-stats.html:** cards grid, sections, bar-charts, balance-meter, health-badges, bar-row, bar-fill, bar-track, bar-value, bar-label, notes, empty-state, recent-games
- **Shared:** root variables, body, wrapper, tables, mobile breakpoints

Single `.admin-wrap` wrapper class. Enhanced mobile breakpoints:
- Horizontal-scrolling tab bar
- Horizontal-scrolling tables in overflow containers
- 44px minimum touch targets on all buttons
- Responsive cards grid

### JavaScript Architecture

**Shared helpers** (deduplicated from all 3 pages):
- `api(path)` — fetch with auth token, redirect on 401/403
- `timeAgo(unixSeconds)` — relative time display
- `formatUptime(seconds)` — hours/minutes/seconds format
- `shortId(id)` — truncate UUID to 8 chars
- `_esc(str)` — HTML escape
- `pct(n, total)` — percentage with 1 decimal
- `fmtDuration(ms)` — milliseconds to "Xm Ys" format
- `balanceBadge(heroWinPct)` — good/warning/bad badge for faction balance
- `roundsBadge(avg)` — good/warning/bad badge for game length
- `winRateBadge(winPct)` — good/warning/bad badge for win rate
- `card(value, label, cls)` — summary card HTML
- `barRow(label, count, max, color, suffix)` — bar chart row HTML

**Tab system:**
```javascript
const _tabLoaded = {};
// On tab click: switch active class, lazy-load if first visit
// loadTabData(tabId) dispatches to per-tab loader
```

**Per-tab loaders:**
- `loadStats()` + `loadRooms()` — Dashboard (from admin.html)
- `loadSaves()` + `loadCompletedGames()` — Games (from admin.html)
- `loadPlayers()` — Players (from admin.html)
- `loadBalanceStats()` → `renderBalance(data)` — Balance (from admin-stats.html `render()`)
- `loadCampaignStats()` → `renderCampaign(data)` — Campaign (from admin-campaign-stats.html `render()`)

**Important:** Balance tab does NOT include campaign data at the bottom (unlike current admin-stats.html). Campaign data lives exclusively in the Campaign tab.

### Server Changes

In `server.js` lines 461-463:
```javascript
// Before (remove):
app.get('/admin/stats',         (_req, res) => res.sendFile(...));
app.get('/admin/campaign-stats',(_req, res) => res.sendFile(...));

// After (redirect for old bookmarks):
app.get('/admin/stats',         (_req, res) => res.redirect('/admin'));
app.get('/admin/campaign-stats',(_req, res) => res.redirect('/admin'));
```

All `/admin/api/*` endpoints remain unchanged.

### Files Deleted
- `admin-stats.html`
- `admin-campaign-stats.html`

---

## Implementation Checklist

- [x] Fix spectate bug in `src/main.js` (auth before spectate request)
- [ ] Write unified CSS block for admin.html
- [ ] Write HTML body with 5 tab containers + sub-tabs for Games
- [ ] Write JS: auth gate, shared helpers, tab system with lazy loading
- [ ] Write JS: Dashboard tab (loadStats, loadRooms, spectateRoom, auto-refresh)
- [ ] Write JS: Games tab (loadSaves, activateSave, loadCompletedGames with MP/SP sub-tabs)
- [ ] Write JS: Players tab (loadPlayers)
- [ ] Write JS: Balance tab (loadBalanceStats, renderBalance)
- [ ] Write JS: Campaign tab (loadCampaignStats, renderCampaign)
- [ ] Update server.js routes (redirects)
- [ ] Delete old HTML files
- [ ] Run tests
- [ ] Push to branch
