# Brimstone — Specification

This folder is a **self-contained, implementation-grade specification** of the game *Brimstone*
(codename for *Caleb's Hollow*). The goal is that an engineer — or another agent — could read these
three documents and build a **behaviourally-identical** game, server, AI, and client without reading
the original source.

## The three documents

| Doc | Scope |
|-----|-------|
| **[01 · Game Design Spec](01-game-design-spec.md)** | The complete ruleset: hex grid, map generation, tiles, entities & units, the dice-pool combat system, actions, the round/turn resolution algorithm, phase cycle, scoring & victory — **plus the full server API and turn/wire payloads**. Enough to build an identical authoritative server. |
| **[02 · AI System Spec](02-ai-system-spec.md)** | The AI that plays both factions: the shared 5-stage goal pipeline, every goal's scoring formula, the personality registries, combat estimation, fog handling, multiplayer coordination, and balance. |
| **[03 · Client Behavior Spec](03-client-behavior-spec.md)** | The browser client: app modes & transitions, the Ledger setup flow, every in-game UI surface, planning interactions, camera/input, the 3D renderer interface, and resolution/replay/conversation presentation — illustrated with screenshots of the running game. |

Read order: **01 → 02 → 03**. Doc 01 establishes the vocabulary (ROUND / TURN / ACTION) and the data
model the other two build on.

## Two things to internalise first

1. **The authority is the source of truth, not a seed.** Round resolution uses an *unseeded* RNG, so it
   is **not** a reproducible function of `(state, plans, seed)`. The authority resolves once and ships
   the resulting event stream (`steps[]`) plus the serialized final state; everyone else *replays* that
   stream and never re-runs the resolver. See Doc 01 §0.2. A reimplementation interoperates by
   reproducing the *wire payloads*, not by re-deriving outcomes.
2. **One rule engine, two orchestrators.** The same DOM-free engine runs offline (a local client is the
   authority) and online (the server is the authority). Doc 01 §12 lists the parity rules.

## Diagrams & images

All diagrams are generated (no ASCII art) and live in [`images/`](images/); their sources are in
[`images/src/`](images/src/) (`.dot` for Graphviz, `.mmd` for Mermaid, `.svg`/generator for hand-built
art). Regenerate with Graphviz (`dot`), Mermaid (`mmdc`), and the SVG renderer. Screenshots were
captured from the real game in headless Chromium via `scripts/verify/browser-harness.mjs`.

| Image | Used in | Source |
|-------|---------|--------|
| `phase-cycle.png` | 01 | `src/phase-cycle.dot` |
| `hex-coords.png` | 01 | `src/hex-coords-gen.mjs` |
| `map-generation.png` | 01 | `src/map-generation.dot` |
| `combat-resolution.png` | 01 | `src/combat-resolution.mmd` |
| `turn-resolution.png` | 01 | `src/turn-resolution.mmd` |
| `room-lifecycle.png` | 01 | `src/room-lifecycle.dot` |
| `online-resolution-sequence.png` | 01 | `src/online-resolution-sequence.mmd` |
| `ai-pipeline.png` | 02 | `src/ai-pipeline.dot` |
| `appmode-state-machine.png` | 03 | `src/appmode-state-machine.dot` |
| `shot-*.png` | 03 | verifier-browser screenshots |

## Authority of this spec vs. the codebase

Where the repository's own internal design docs (`docs/`) disagree with the source code, **this spec
follows the code** and footnotes the discrepancy. Each document ends with a "Notes & discrepancies"
section listing the stale-doc deltas a reimplementer should be aware of (e.g. combat magnitudes, AI goal
counts, the AppMode `SUBMITTED`/`SPECTATING` reality).
