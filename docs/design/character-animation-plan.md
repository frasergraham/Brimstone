# Character Animation Plan

Status: planning / asset-gathering. Last updated 2026-06-10.

This document captures the **animation gap analysis** for the Babylon.js 3D renderer and
the **Mixamo shopping list** for clips we still need to gather and wire up. It is a
reference for sourcing assets — it does not prescribe an implementation order beyond the
priority tiers.

## How animation works today

The WebGL renderer (`src/renderer-3d.js`) drives characters through a small fixed
vocabulary of clip **slots**. Each slot maps to one Mixamo `.glb` (one clip per file).

- **Clip bank** — `ANIMATION_BANK` (`src/renderer-3d.js:589`) names the loadable clips:
  `idle`, `walking`, `running`, `punch`, `hit`, `block`.
- **Per-unit rig bank** — `UNIT_RIG_BANK` (`src/renderer-3d.js:607`) maps an entity type to
  its model + the clips that apply. Only `PALADIN` is fully defined today; commented
  stubs for `WITCH`/`ZOMBIE` show the intended shape.
- **Clip slots** — `_rigClipSlots(src)` (`src/renderer-3d.js:4830`) is the source of truth
  for the slots a rig can fill and their playback behaviour (loop vs one-shot, speed,
  duration tracking): `idle`, `walk`, `run`, `punch`, `hit`, `block`.
- **Fallbacks** — a missing clip falls back to `idle` (`_setCloneAnimState`, ~4891). A
  unit type with no dedicated `<type>-idle.glb` cascades to `mannequin-idle.glb`, then to a
  cone+sphere pawn (`entityTypeRigFile`, `src/renderer-3d.js:652`).
- **Running is dormant** — `RUNNING_ANIM_ENABLED = false` (`src/renderer-3d.js:562`); the
  clip exists but nothing selects it. Flip the flag to enable (no download needed).

### Current coverage

| Unit | idle | walk | run | punch | hit | block |
|------|------|------|-----|-------|-----|-------|
| Paladin | ✅ (embedded) | ✅ | ✅ (dormant) | ✅ | ✅ | ✅ |
| Zombie | ✅ (`zombie-idle.glb`) | mannequin | mannequin | mannequin | mannequin | mannequin |
| All others | mannequin | mannequin | mannequin | mannequin | mannequin | mannequin |

The six slots are the **entire** current motion vocabulary. Mapped against the 12 game
actions (`ActionType`, `src/actions.js:28`) and combat outcomes, the gaps below remain.

## Gap → game-event mapping

The renderer plays locomotion (idle/walk/run) plus one-shot reactions (punch/hit/block).
These game events currently play *nothing* distinct, or wrongly reuse `punch`:

| Event | Today | Needed slot |
|-------|-------|-------------|
| Ranged attack — bow/crossbow/sling (`BATTLE`/`BATTLE_HEX`, `ITEMS[weapon].range > 1`) | plays melee `punch` | `shoot` |
| Ranged attack — musket/pistol | plays melee `punch` | `fire` (or reuse `shoot`) |
| Witch `magic_bolt`, `SUMMON`, most `USE_ABILITY` | plays `punch` | `cast` |
| Entity death (HP→0, heroKills/witchKills) | nothing (vanishes) | `death` |
| `FORTIFY` | nothing | `fortify` |
| `HEAL` | nothing | `heal` |
| `EXPLORE` (search building) | nothing | `search` |
| `USE_ITEM` | nothing | `use_item` (drink) |
| `EQUIP_WEAPON` | nothing | `equip` (draw weapon) |
| `SOUND_HORN` | nothing | `horn` (shout) |
| `GUARD` | nothing | `guard` (held block stance — distinct from one-shot `block`) |
| Crush outcome (2 dmg) | `hit` | `stagger` (optional) |
| Counter outcome | nothing | `counter` (optional) |

The ranged-attack gap is the most visible: the weapons overhaul (2026-06) added
bow/crossbow/musket/pistol/sling, all of which currently animate as a melee punch.

## Mixamo shopping list

Gather each as **"Without Skin"** (skeleton-only FBX) on the standard Mixamo skeleton,
drop into `assets/source/animations/`, convert via `scripts/convert-mixamo-anim.js`
(one clip → one `.glb` in `assets/models/`).

### Tier 1 — fills real gaps (gather first)

- [ ] **shoot** → *"Standing Draw Arrow"* (+ *"Standing Aim Recoil"* for a separate loose) — bow/crossbow/sling
- [ ] **fire** → *"Firing Rifle"* or *"Pistol Idle → Firing"* — musket/pistol (or reuse `shoot` for all ranged)
- [ ] **cast** → *"Standing 1H Magic Attack 01"* / *"Spell Cast"* — witch magic_bolt, summon, abilities
- [ ] **death** → *"Falling Back Death"* / *"Dying"* — one-shot, hold last frame

### Tier 2 — action clips (one-to-one with game actions)

- [ ] **fortify** → *"Hammering"* / *"Picking Up Object"* — FORTIFY
- [ ] **heal** → *"Praying"* / *"Kneeling"* — HEAL
- [ ] **search** → *"Searching A Drawer"* / *"Crouch Search"* — EXPLORE
- [ ] **use_item** → *"Drinking"* — USE_ITEM
- [ ] **equip** → *"Sword And Shield Equip"* / *"Draw Weapon"* — EQUIP_WEAPON
- [ ] **horn** → *"Yelling"* / *"Cheering"* — SOUND_HORN
- [ ] **guard** → *"Standing Block Idle"* (looping) — GUARD (held stance)

### Tier 3 — polish (optional)

- [ ] **stagger** → *"Hit Reaction"* (heavy) / *"Stunned"* — crush outcomes
- [ ] **counter** → *"Sword Riposte"* / quick strike — counter outcomes
- [ ] **shamble** → *"Zombie Walk"* — zombie-specific walk
- [ ] **run** — *already have `running.glb`*; flip `RUNNING_ANIM_ENABLED` (`src/renderer-3d.js:562`) to `true`. No download.

### Per-unit idle models (separate from clips)

These are full **"With Skin"** character exports, each producing `<type>-idle.glb`, run
through `scripts/convert-character-fbx.js` (or `scripts/fbx-to-glb-blender.py` for
cm-scale rigs). Sources live in `assets/source/characters/`.

- [ ] `witch-idle.glb` · [ ] `necromancer-idle.glb` · [ ] `brute-idle.glb`
- [ ] `rogue-idle.glb` · [ ] `captain-idle.glb` · [ ] `soldier-idle.glb`
- [ ] `minion-idle.glb` · [ ] `wood_golem-idle.glb` · [ ] `iron_golem-idle.glb` · [ ] `survivor-idle.glb`

Already exist: `paladin-idle.glb`, `zombie-idle.glb`.

## Wiring a new clip (when assets land)

1. Convert FBX → `.glb` via `scripts/convert-mixamo-anim.js` (clips) or
   `scripts/convert-character-fbx.js` (models).
2. Add the file to `ANIMATION_BANK` (`src/renderer-3d.js:589`).
3. Add the slot to `_rigClipSlots` (`src/renderer-3d.js:4830`) with loop/one-shot/speed/
   duration behaviour.
4. Reference the clip from the relevant `UNIT_RIG_BANK` entries (`src/renderer-3d.js:607`).
5. Add the event→slot trigger so it fires on the matching resolver event/action.

## Conventions

- One clip per source FBX → one `.glb`.
- Clip sources: `assets/source/animations/`; character sources:
  `assets/source/characters/`.
- Bone names are normalised to `mixamorig:` during conversion.
- The `.glb` output ships; FBX sources are gitignored (except the Paladin 40k source).
