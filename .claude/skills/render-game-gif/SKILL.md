---
name: render-game-gif
description: Render an AI-vs-AI game as an animated GIF via the headless runner — the fastest way to eyeball AI behavior, map generation, or pacing changes without a browser session
argument-hint: [size] [--players N] [out.gif]
---

# Render a Game as a GIF

`scripts/headless.js --render` plays one AI-vs-AI game and writes an animated
GIF of the whole match — useful for eyeballing AI behavior changes, map
generation tweaks, or pacing, without spinning up the browser harness.

## Usage

```bash
node scripts/headless.js --render standard out.gif          # 1v1 standard
node scripts/headless.js --render campaign --players 4      # 4v4 campaign map
node scripts/headless.js --render skirmish --players 2 out.gif
```

- Sizes: `skirmish` | `standard` | `regional` | `campaign` | `battle` (42×42,
  up to `--players 10`).
- Faction overrides: `--day=<factionId>` / `--night=<factionId>` (defaults
  `hero` / `witch`; stubs like `rogue`, `captain`, `necromancer`, `brute`
  swap the leader's stats).
- Write the GIF into the scratchpad directory unless the user names a path —
  don't litter the repo.

## Workflow

1. Run the render (a full game can take a minute or two — use a background
   Bash call for large maps).
2. **Actually look at it** — send the GIF to the user with `SendUserFile` and
   read key frames yourself if the point was verifying a behavior change
   (e.g. "does the hero now contest nodes at dusk?").
3. One game is one sample. A GIF shows you *how* the AI behaves, not
   *whether balance moved* — pair it with the `balance-check` skill for any
   conclusion about win rates.

## Related

- `node scripts/render-3d-map.js` (`npm run render:3d-map`) — static 3D map
  render, for map-generation-only checks.
- `verifier-browser` skill — for anything involving the real renderer/UI;
  the GIF uses the headless painter, not the shipping 3D renderer.
