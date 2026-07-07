// ─────────────────────────────────────────────────────────────────────────────
// Brimstone icon manifest — SINGLE SOURCE OF TRUTH for the monochrome icon set.
//
// This file drives BOTH:
//   • the font build  (scripts/build-icon-font.mjs → assets/fonts/brimstone-icons.woff2)
//   • the runtime map (src/icons.js, generated → `ICON` + `EMOJI_TO_ICON`)
//
// Each entry:
//   name   — stable semantic key used in code as ICON.<name>. NEVER renamed casually;
//            this is the API every call site depends on. The artwork behind it is
//            swappable without touching call sites.
//   code   — Private-Use-Area codepoint (U+E000+). Stable once shipped.
//   gi     — game-icons.net icon id (author/icon). FIRST-PASS / swappable art choice.
//            Verify/redraw freely later; call sites don't care.
//   glyphs — the old emoji/symbol literals this icon replaces. Used to (a) audit
//            coverage and (b) drive mechanical replacement WHERE a glyph is NOT
//            overloaded. Overloaded glyphs (see `shared:true`) must be replaced
//            by hand at each site to the correct semantic icon.
//   note   — disambiguation guidance for overloaded glyphs / tinting requirements.
//
// `shared` glyphs (appear under more than one icon) are intentionally listed on
// every icon they can mean; EMOJI_TO_ICON omits them so a blind pass can't guess
// wrong — they get hand-mapped per call site.
// ─────────────────────────────────────────────────────────────────────────────

export const ICONS = [
  // ── Factions & entity types (painted in DOM *and* canvas: renderer-3d.js,
  //    renderer.js, replay-timeline.js entity-glyph maps) ──────────────────────
  { name: 'hero',        code: 0xE000, gi: 'lorc/crossed-swords',      glyphs: ['⚔'], shared: true,
    note: '⚔ overloaded: hero faction glyph, generic battle/critical badge, "⚔ vs AI", "⚔ Supplies". Use ICON.hero only for the FACTION; use ICON.battle for combat, ICON.supplies for the cache.' },
  { name: 'witch',       code: 0xE001, gi: 'delapouite/pointy-hat',    glyphs: ['✦'], shared: true,
    note: '✦ overloaded: witch faction glyph + "✦ Rewards" section. Use ICON.witch for faction; ICON.reward for the debrief section.' },
  { name: 'survivor',    code: 0xE002, gi: 'delapouite/person',        glyphs: ['☺'], shared: true,
    note: '☺ = survivor entity glyph; also a generic smile in a couple of logs. Default ICON.survivor.' },
  { name: 'soldier',     code: 0xE003, gi: 'delapouite/chess-pawn',    glyphs: ['♟'] },
  { name: 'minion',      code: 0xE004, gi: 'lorc/cultist',             glyphs: [] , note: 'entity-map only (witch minion). The "☠" that currently marks a minion is hand-mapped here.' },
  { name: 'zombie',      code: 0xE005, gi: 'lorc/shambling-zombie',    glyphs: ['†'], shared: true, note: '† dagger is also used generically; entity-map site → ICON.zombie.' },
  { name: 'woodGolem',   code: 0xE006, gi: 'lorc/totem',              glyphs: [], note: 'entity-map only. The "🪵" marking a wood golem is hand-mapped here, NOT to ICON.wood.' },
  { name: 'ironGolem',   code: 0xE007, gi: 'delapouite/robot-golem',   glyphs: [], note: 'entity-map only. The "⚙" marking an iron golem is hand-mapped here, NOT to ICON.metal.' },
  { name: 'captain',     code: 0xE008, gi: 'caro-asercion/centurion-helmet', glyphs: ['⛨'] },
  { name: 'necromancer', code: 0xE009, gi: 'lorc/raise-zombie',        glyphs: ['☥'] },
  { name: 'rogue',       code: 0xE00A, gi: 'lorc/hood',                glyphs: [], note: 'entity stub; "🗡" placeholder hand-mapped here, NOT to ICON.dagger.' },
  { name: 'ogre',        code: 0xE00B, gi: 'lorc/ogre',                glyphs: ['👹'] },
  { name: 'person',      code: 0xE00C, gi: 'delapouite/person',        glyphs: ['🧑'] },
  { name: 'skeleton',    code: 0xE00D, gi: 'delapouite/skeleton',      glyphs: [], note: 'entity-map only (necromancer skeleton summon).' },

  // ── Resources (actions.js RES_ICON, ui-render.js, campaign rewards) ─────────
  { name: 'wood',      code: 0xE010, gi: 'delapouite/wood-pile',       glyphs: ['🪵'], shared: true, note: 'resource. 🪵 also = wood golem entity (→ ICON.woodGolem) and log marker.' },
  { name: 'metal',     code: 0xE011, gi: 'delapouite/metal-bar',       glyphs: ['⚙'], shared: true, note: '⚙ also = iron golem (→ ICON.ironGolem) and settings button (→ ICON.gear).' },
  { name: 'food',      code: 0xE012, gi: 'delapouite/sliced-bread',    glyphs: ['🍞','🍖'] },
  { name: 'silver',    code: 0xE013, gi: 'delapouite/two-coins',       glyphs: ['🥈','🪙'], note: 'tint silver/grey at call site if desired.' },
  { name: 'scripture', code: 0xE014, gi: 'lorc/scroll-unfurled',       glyphs: ['📜'], shared: true, note: '📜 also = Chronicle title (→ ICON.chronicle).' },
  { name: 'herb',      code: 0xE015, gi: 'lorc/high-grass',            glyphs: ['🌿'], shared: true, note: '🌿 also = grass tile (→ ICON.grass).' },
  { name: 'backpack',  code: 0xE016, gi: 'delapouite/knapsack',        glyphs: ['🎒'] },

  // ── Phase markers (game.js PHASE_ICON) ──────────────────────────────────────
  { name: 'dawn',  code: 0xE020, gi: 'lorc/sunrise',     glyphs: ['🌅'] },
  { name: 'day',   code: 0xE021, gi: 'lorc/sun',         glyphs: ['☀'] },
  { name: 'dusk',  code: 0xE022, gi: 'lorc/sunset',      glyphs: ['🌇'] },
  { name: 'night', code: 0xE023, gi: 'lorc/moon',        glyphs: ['🌙'] },
  { name: 'newMoon', code: 0xE024, gi: 'lorc/evil-moon',  glyphs: ['🌑','🌒'], note: 'campaign ritual logs.' },

  // ── Buildings (tiles.js BUILDING_ICON) ──────────────────────────────────────
  { name: 'townhall',   code: 0xE030, gi: 'delapouite/greek-temple',   glyphs: ['🏛'] },
  { name: 'inn',        code: 0xE031, gi: 'delapouite/saloon-doors',   glyphs: ['🏨'] },
  { name: 'church',     code: 0xE032, gi: 'delapouite/church',         glyphs: ['⛪'] },
  { name: 'blacksmith', code: 0xE033, gi: 'lorc/anvil-impact',         glyphs: ['⚒'], shared: true, note: '⚒ also = War Hammer weapon (→ ICON.warhammer).' },
  { name: 'graveyard',  code: 0xE034, gi: 'delapouite/tombstone',                glyphs: ['🪦'] },
  { name: 'dock',       code: 0xE035, gi: 'delapouite/anchor',         glyphs: ['⚓'] },
  { name: 'barn',       code: 0xE036, gi: 'delapouite/barn',           glyphs: ['🌾'], shared: true, note: '🌾 wheat → barn building.' },
  { name: 'watchtower', code: 0xE037, gi: 'delapouite/watchtower',     glyphs: ['🗼'] },
  { name: 'apothecary', code: 0xE038, gi: 'delapouite/mortar',         glyphs: ['⚗'], shared: true, note: '⚗ alembic → apothecary.' },
  { name: 'stable',     code: 0xE039, gi: 'lorc/horse-head',           glyphs: ['🐎'] },
  { name: 'storehouse', code: 0xE03A, gi: 'delapouite/wooden-crate',   glyphs: ['📦'], shared: true, note: '📦 also = generic "Found:" loot readout — same icon is fine.' },
  { name: 'fort',       code: 0xE03B, gi: 'lorc/tower-fall',           glyphs: ['🏰'], note: 'fortifications.' },
  { name: 'shelter',    code: 0xE03C, gi: 'delapouite/house',          glyphs: ['🏠'] },
  { name: 'mill',       code: 0xE03D, gi: 'delapouite/windmill',       glyphs: [], note: 'MILL building currently uses ⚙ (overloaded) — hand-map here.' },

  // ── Weapons & carried items (items.js labels) ───────────────────────────────
  { name: 'sword',     code: 0xE0A2, gi: 'lorc/broadsword',            glyphs: [], note: 'single-blade weapon icon for Sword/Great Sword labels; ⚔ (crossed-swords) stays the FACTION/battle glyph.' },
  { name: 'dagger',    code: 0xE040, gi: 'lorc/plain-dagger',          glyphs: ['🗡'], shared: true, note: '🗡 also = rogue entity stub (→ ICON.rogue).' },
  { name: 'axe',       code: 0xE041, gi: 'lorc/battle-axe',            glyphs: ['🪓'] },
  { name: 'shield',    code: 0xE042, gi: 'lorc/checked-shield',        glyphs: ['🛡'], shared: true, note: '🛡 = Shield item, Guard status effect, AND the Auto-guard plan button — all read as "shield", reuse is fine.' },
  { name: 'bow',       code: 0xE043, gi: 'lorc/pocket-bow',            glyphs: ['🏹'], note: 'bow + crossbow labels.' },
  { name: 'gun',       code: 0xE044, gi: 'delapouite/musket',       glyphs: ['🔫'], note: 'musket/flintlock/rifle.' },
  { name: 'sling',     code: 0xE045, gi: 'lorc/sling',                 glyphs: [], note: 'Sling weapon currently uses 🪨 (overloaded w/ dirt tile) — hand-map here.' },
  { name: 'staff',     code: 0xE046, gi: 'lorc/wizard-staff',          glyphs: ['🪄'], shared: true, note: '⚕ "Staff (undead)" combat-breakdown line also → ICON.staff.' },
  { name: 'warhammer', code: 0xE047, gi: 'lorc/warhammer',            glyphs: [], note: '⚒ War Hammer item — hand-map (⚒ default is blacksmith).' },
  { name: 'horse',     code: 0xE048, gi: 'lorc/horseshoe',             glyphs: ['🐴'] },
  { name: 'horn',      code: 0xE049, gi: 'lorc/bugle-call',            glyphs: ['📯'] },

  // ── Terrain tiles (ui.js TILE_ICON) ─────────────────────────────────────────
  { name: 'grass',  code: 0xE050, gi: 'delapouite/grass',             glyphs: [], note: '🌿 in tile map → hand-map here (🌿 default is herb).' },
  { name: 'forest', code: 0xE051, gi: 'lorc/pine-tree',              glyphs: ['🌲'] },
  { name: 'dirt',   code: 0xE052, gi: 'lorc/stone-block',            glyphs: [], note: '🪨 in tile map → hand-map here (🪨 default is rock/sling).' },
  { name: 'rock',   code: 0xE053, gi: 'lorc/rock',                   glyphs: ['🪨'], shared: true, note: 'default for 🪨; dirt tile + sling are hand-mapped elsewhere.' },
  { name: 'road',   code: 0xE054, gi: 'delapouite/path-distance',    glyphs: ['🛤'] },
  { name: 'river',  code: 0xE055, gi: 'lorc/water-drop',             glyphs: ['💧'], shared: true, note: '💧 also = Water status effect (→ ICON.water).' },
  { name: 'bridge', code: 0xE056, gi: 'delapouite/stone-bridge',     glyphs: ['🌉'] },

  // ── Status effects (effects.js EFFECT icon field) ───────────────────────────
  { name: 'bleed',   code: 0xE060, gi: 'lorc/bleeding-wound',  glyphs: ['🩸'] },
  { name: 'target',  code: 0xE061, gi: 'lorc/on-target',       glyphs: ['🎯'], shared: true, note: '🎯 also = point-blank note + Skirmish menu icon.' },
  { name: 'sparkle', code: 0xE062, gi: 'lorc/sparkles',        glyphs: ['✨'], note: 'node power / heal sparkle.' },
  { name: 'water',   code: 0xE063, gi: 'lorc/droplets',        glyphs: [], note: 'Water effect — hand-map (💧 default is river).' },
  { name: 'stun',    code: 0xE064, gi: 'lorc/star-swirl',      glyphs: ['💫'] },
  { name: 'slow',    code: 0xE065, gi: 'lorc/snail',           glyphs: ['🐌'] },
  { name: 'fire',    code: 0xE066, gi: 'lorc/flame',           glyphs: ['🔥'] },
  { name: 'candle',  code: 0xE067, gi: 'lorc/candle-flame',    glyphs: ['🕯'], shared: true, note: '🕯 also = witch "Stores" cache label.' },
  { name: 'eye',     code: 0xE068, gi: 'lorc/eye-target',      glyphs: ['👁'], note: 'reveal/sense.' },
  { name: 'poison',  code: 0xE069, gi: 'lorc/death-skull',     glyphs: [], note: 'poison effect currently ☠ — hand-map (☠ default is minion/skull).' },

  // ── Long-tail UI glyphs (media controls, time, movement, memorial) ──────────
  { name: 'wind',      code: 0xE0B3, gi: 'lorc/wind-slap',           glyphs: ['💨'], note: 'player left/removed, knockback push, companions scatter.' },
  { name: 'coffin',    code: 0xE0B4, gi: 'lorc/coffin',              glyphs: ['⚰'], note: 'campaign Fallen memorial.' },
  { name: 'hourglass', code: 0xE0B5, gi: 'lorc/hourglass',          glyphs: ['⏳'], note: 'reconnect spinner, time-ran-out.' },
  { name: 'timer',     code: 0xE0B6, gi: 'lorc/stopwatch',          glyphs: ['⏱'], note: 'async deadline countdown.' },
  { name: 'pause',     code: 0xE0B7, gi: 'delapouite/pause-button', glyphs: ['⏸'] },
  { name: 'play',      code: 0xE0B8, gi: 'delapouite/play-button',  glyphs: ['▶'], note: 'playback resume (▶ is BMP-geometric but renders color on mobile).' },

  // ── UI chrome, actions, toggles ─────────────────────────────────────────────
  { name: 'close',      code: 0xE070, gi: 'delapouite/cancel',        glyphs: ['✕'] },
  { name: 'check',      code: 0xE071, gi: 'delapouite/check-mark',    glyphs: ['✓'], note: 'sometimes tinted green via wrapping span — tint survives (monochrome inherits color).' },
  { name: 'menu',       code: 0xE072, gi: 'delapouite/hamburger-menu', glyphs: ['☰'] },
  { name: 'arrowRight', code: 0xE073, gi: 'delapouite/arrow-dunk',    glyphs: ['➤'], note: 'offscreen-unit pointer (also rotated in CSS).' },
  { name: 'star',       code: 0xE074, gi: 'delapouite/rss',           glyphs: ['★'], note: 'doubler marker; pick a solid star.' },
  { name: 'fit',        code: 0xE075, gi: 'delapouite/expand',        glyphs: ['⛶'] },
  { name: 'soundOn',    code: 0xE076, gi: 'delapouite/speaker',       glyphs: ['🔊'] },
  { name: 'soundOff',   code: 0xE077, gi: 'delapouite/speaker-off',   glyphs: ['🔇'] },
  { name: 'planning',   code: 0xE078, gi: 'delapouite/scroll-quill',  glyphs: ['📋'] },
  { name: 'chronicle',  code: 0xE079, gi: 'lorc/book-cover',          glyphs: [], note: '📜 Chronicle/title → hand-map (📜 default is scripture).' },
  { name: 'missionLog', code: 0xE07A, gi: 'delapouite/notebook',      glyphs: ['🗒'] },
  { name: 'conversation', code: 0xE07B, gi: 'delapouite/conversation', glyphs: ['💬'] },
  { name: 'pin',        code: 0xE07C, gi: 'delapouite/drop',          glyphs: ['📌'] },
  { name: 'unpin',      code: 0xE07D, gi: 'delapouite/folded-paper',     glyphs: ['📎'] },
  { name: 'book',       code: 0xE07E, gi: 'delapouite/open-book',     glyphs: ['📖'] },
  { name: 'bot',        code: 0xE07F, gi: 'delapouite/vintage-robot', glyphs: ['🤖'] },
  { name: 'players',    code: 0xE080, gi: 'delapouite/backup',        glyphs: ['👥'] },
  { name: 'lock',       code: 0xE081, gi: 'lorc/padlock',             glyphs: ['🔒'] },
  { name: 'invite',     code: 0xE082, gi: 'delapouite/envelope',      glyphs: ['✉'] },
  { name: 'warning',    code: 0xE083, gi: 'delapouite/uncertainty',   glyphs: ['⚠'], note: 'several ⚠ are in CODE COMMENTS — do NOT replace those; only player-facing strings.' },
  { name: 'balance',    code: 0xE084, gi: 'delapouite/scales',        glyphs: ['⚖'], note: 'draw / tie scoring.' },
  { name: 'speedCine',  code: 0xE085, gi: 'delapouite/film-strip',    glyphs: ['🎬'] },
  { name: 'speedFast',  code: 0xE086, gi: 'delapouite/fast-forward-button',  glyphs: ['⏩'] },
  { name: 'speedVfast', code: 0xE087, gi: 'delapouite/next-button',  glyphs: ['⏭'] },
  { name: 'heartFull',  code: 0xE088, gi: 'delapouite/hearts',        glyphs: ['♥'] },
  { name: 'heartEmpty', code: 0xE089, gi: 'lorc/broken-heart', glyphs: ['♡'] },
  { name: 'medical',    code: 0xE08A, gi: 'delapouite/health-normal', glyphs: ['⚕'] },
  { name: 'fatigue',    code: 0xE08B, gi: 'lorc/despair',             glyphs: ['😓'] },
  { name: 'unarmed',    code: 0xE08C, gi: 'lorc/fist',               glyphs: ['👊'] },
  { name: 'brimstone',  code: 0xE08D, gi: 'lorc/flame',            glyphs: ['🜂'], note: 'ledger thumbnail placeholder.' },
  { name: 'hexNode',    code: 0xE08E, gi: 'delapouite/hexagonal-nut', glyphs: ['⬡'], note: 'terrain/power-node chip — tinted per node color at call site.' },
  { name: 'sentTo',     code: 0xE08F, gi: 'delapouite/love-letter',       glyphs: ['📤'] },
  { name: 'receivedFrom', code: 0xE090, gi: 'delapouite/mailbox',      glyphs: ['📥'] },
  { name: 'join',       code: 0xE091, gi: 'lorc/lightning-trio',     glyphs: ['⚡'], note: 'player joined / node contested.' },
  { name: 'off',        code: 0xE092, gi: 'delapouite/cancel',       glyphs: ['🚫'] },
  { name: 'lunge',      code: 0xE093, gi: 'delapouite/fencer',       glyphs: ['🤺'] },
  { name: 'seed',       code: 0xE094, gi: 'lorc/seedling',           glyphs: ['🌱'], note: 'map seed readout.' },
  { name: 'splash',     code: 0xE095, gi: 'lorc/water-splash',       glyphs: ['💢'], note: 'splash damage.' },
  { name: 'crush',      code: 0xE096, gi: 'lorc/explosion-rays',     glyphs: ['💥'], note: 'crushing blow.' },
  { name: 'defeat',     code: 0xE097, gi: 'lorc/death-skull',        glyphs: ['💀'], note: 'defeat/death (separate from minion skull so art can differ).' },
  { name: 'golem',      code: 0xE098, gi: 'lorc/rock-golem',        glyphs: ['🗿'], note: 'campaign golem spawn logs.' },
  { name: 'nodeHero',   code: 0xE099, gi: 'delapouite/circle',       glyphs: ['🔵'], note: 'TINT hero-blue at call site (mono glyph carries no color).' },
  { name: 'nodeWitch',  code: 0xE09A, gi: 'delapouite/circle',       glyphs: ['🔴'], note: 'TINT witch-red at call site.' },
  { name: 'nodeNeutral', code: 0xE09B, gi: 'delapouite/circle-claws', glyphs: ['⭕'], note: 'hollow ring; uncontrolled node.' },
  { name: 'checkbox',   code: 0xE09C, gi: 'delapouite/checklist', glyphs: ['☐'] },
  { name: 'heartbreak', code: 0xE09D, gi: 'lorc/heart-minus',        glyphs: ['💔'] },
  { name: 'battle',     code: 0xE09E, gi: 'lorc/crossed-swords',     glyphs: [], note: 'generic combat marker — ⚔ used for battle/critical/vs is hand-mapped here (distinct from ICON.hero faction).' },
  { name: 'reward',     code: 0xE09F, gi: 'lorc/trophy',             glyphs: [], note: '✦ Rewards section — hand-map (✦ default is witch).' },
  { name: 'supplies',   code: 0xE0A0, gi: 'delapouite/cardboard-box-closed', glyphs: [], note: '⚔ Supplies / 🕯 Stores cache labels — hand-map.' },
  { name: 'gear',       code: 0xE0A1, gi: 'delapouite/gears',        glyphs: [], note: 'Settings/options button — ⚙ hand-mapped here (⚙ default is metal).' },

  // ── 2D renderer (editor-only) faction/markers & shadow glyphs ───────────────
  { name: 'pentacle',   code: 0xE0B0, gi: 'lorc/pentacle',          glyphs: ['⛧'] },
  { name: 'flag',       code: 0xE0B1, gi: 'delapouite/flying-flag',        glyphs: ['⚑'] },
  { name: 'wardShield',  code: 0xE0B2, gi: 'lorc/shield-impact',     glyphs: ['⛨'], note: 'renderer.js captain/ward placeholder (distinct from ICON.captain if needed).' },
  { name: 'catapult',   code: 0xE0B9, gi: 'lorc/catapult',          glyphs: [], note: 'Catapult siege unit (Captain faction) — entity glyph + Build Siege action + Catapult Stone weapon label.' },
];

// Sanity: no duplicate names or codes.
const seenName = new Set(), seenCode = new Set();
for (const it of ICONS) {
  if (seenName.has(it.name)) throw new Error(`duplicate icon name: ${it.name}`);
  if (seenCode.has(it.code)) throw new Error(`duplicate icon code: U+${it.code.toString(16)}`);
  seenName.add(it.name); seenCode.add(it.code);
}
