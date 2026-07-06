---
name: add-icon
description: Add or change a glyph in the BrimstoneIcons monochrome icon font — edit the manifest, regenerate src/icons.js and the woff2, and verify no color emoji leaks into player-facing UI
argument-hint: [icon-name] [game-icons id]
---

# Icon Font Pipeline

Player-facing UI never uses color emoji (Guideline 8) — everything goes
through the `BrimstoneIcons` font (PUA `U+E000–E0FF`, art from
game-icons.net). This skill is the exact pipeline for adding or restyling an
icon; skipping a step yields tofu glyphs or a failed emoji-guard test.

## Steps

1. **Edit the manifest** — `scripts/icon-manifest.mjs` is the single source of
   truth. For a new icon add an entry:
   ```js
   { name: 'myIcon', code: 0xE0XX, gi: 'author/icon-id', glyphs: ['🔥'] }
   ```
   - `name` — stable semantic key (`ICON.myIcon`); never rename casually.
   - `code` — next free PUA codepoint in the appropriate section; stable once
     shipped, never reuse.
   - `gi` — game-icons.net id (`author/icon`); this is the swappable art
     choice. To *restyle* an existing icon, change ONLY `gi` and rebuild.
   - `glyphs` — the emoji/symbol literals it replaces. If a glyph is
     overloaded (already listed under another icon), add `shared: true` and a
     `note` — shared glyphs are excluded from `EMOJI_TO_ICON` and must be
     hand-mapped per call site.

2. **Regenerate code and font:**
   ```bash
   node scripts/gen-icons.mjs         # writes src/icons.js (ICON + EMOJI_TO_ICON)
   node scripts/build-icon-font.mjs   # rebuilds assets/fonts/brimstone-icons.woff2/.ttf
   ```
   Both must run; a manifest entry without a font rebuild renders as tofu.

3. **Use it at call sites** by context:
   - JS: `import { ICON } from './icons.js'` → `` `${ICON.myIcon} Label` ``
     (or `'\uE0XX'` in a plain quoted string).
   - `index.html`: `&#xE0XX;` numeric entity.
   - CSS `content`: `'\eXXX'`.
   - Canvas (`renderer-3d.js` / `renderer.js`): keep `BrimstoneIcons` in the
     `ctx.font` family list (already wired at existing paint sites; new paint
     sites must include it) and ensure the font is loaded via
     `document.fonts.load` before first draw.
   - Icons inherit `color` — tint at the call site, don't bake color into art.

4. **Verify:**
   ```bash
   node --test tests/no-ui-emoji.test.js   # emoji guard must pass
   node scripts/gen-icon-sheet.mjs         # optional: contact sheet to eyeball the glyph
   npm test
   ```
   If the icon appears anywhere player-visible, this is visual work — verify
   in the browser with the `verifier-browser` skill before pushing.

5. **Voiced text caveat:** if the icon lands in tutorial/hint bodies or
   conversation lines, TTS strips it automatically (`narrationText()` removes
   `U+E000–E0FF`), but *changing the surrounding text* requires regenerating
   audio — see the `voiceover-regen` skill.

## Emoji carve-outs (allowed without icons)

Code comments, `tests/`, `scripts/`, mission editor / admin tools
(`src/tools/`, `admin*.html`), and `src/icons.js` itself.
