# Piano Tiles

A mobile-responsive Piano Tiles clone. Pick a song, then tap the tiles as they fall down four lanes. The game speeds up as you go and ends if you miss a tile, tap a white cell, or let go of a hold too soon.

**Play online: https://vega-77.github.io/piano-tiles/**

**Stack:** React 19, TypeScript, Vite 8, Tailwind CSS 4, Web Audio API, Canvas 2D, Vitest.

## Run it locally

Requires Node.js 20.19+ (or 22.12+).

```bash
npm install
npm run dev      # dev server at http://localhost:5173
npm test         # unit tests
npm run build    # type-check + production build into dist/
npm run preview  # serve the production build
```

## How to play

- **Touch / mouse:** tap the glowing tiles in order, bottom to top.
- **Keyboard:** `D` `F` `J` `K` are lanes 1–4. `Esc` returns to the song list.
- The first tile waits for your tap before the board starts moving.
- Each tile you clear plays the next note of the song.

### Tile types

| Tile | What to do |
| --- | --- |
| **Tap** (single) | Tap it. |
| **Double** | Two tiles in the same row, exactly one lane apart (lanes 1 & 3, or 2 & 4), joined by a glowing bar. Tap both, in either order. |
| **Hold** (gold, 2–4 rows tall) | Press its head and keep your finger down until the whole tile has flowed past your finger, then let go. Letting go early ends the game. Pressing higher up the tile doesn't shorten the hold. |

### Scoring

One point per tile: each half of a double counts, and a hold is worth 2 (one for grabbing it, one for finishing it). Every 50 points the speed multiplier goes up by 0.05, on top of each song's own base speed. Best scores and play counts are saved per song in `localStorage`.

## Songs

| Song | Difficulty | Features |
| --- | --- | --- |
| Twinkle Twinkle Little Star | Beginner | Holds |
| Ode to Joy | Easy | Holds |
| Für Elise | Medium | Doubles, holds |
| Rondo Alla Turca | Hard | Doubles, holds |
| In the Hall of the Mountain King | Expert | Doubles, holds |

Songs are written as text in `src/songs/songs.ts`, whitespace-separated, with `|` allowed to mark bars:

```
E4        a tap tile
C4+E4     a double: two tiles at once (plays both notes)
G4~       a hold tile, 2 rows tall
G4~3      a hold tile, 3 rows tall (2–4 allowed)
```

To add one, append an entry with a title, composer, `difficulty` (1–5), `speed` (percent of board height per second), two theme hues, and its `notes`. A song loops for as long as you survive. The tests check that every song parses and stays within the rules.

## How it works

The 60fps loop lives outside React so per-frame movement never triggers a render.

| File | Role |
| --- | --- |
| `src/game/engine.ts` | `requestAnimationFrame` loop, beat spawning, tap/double/hold rules, speed ramp |
| `src/game/renderer.ts` | Owns the tile DOM nodes; positions are written straight to `transform` |
| `src/game/effects.ts` | Canvas visuals: animated aurora/star/note backdrop, and hit bursts, ripples, lane beams and score pops |
| `src/game/audio.ts` | Web Audio piano-style synth, with sustained notes for holds |
| `src/game/storage.ts` | Per-song best score and play count |
| `src/songs/` | Song library and the note-notation parser |
| `src/hooks/useGame.ts` | Bridges the engine to React; state updates only on start, each score, and game over |
| `src/index.css` | Tile looks and animations, switched by `data-kind` / `data-state` attributes |
| `src/config.ts` | Tunables: speed step (+0.05 per 50 tiles), tile height, hold tolerance |

Tile positions are percentages of board height (`yPos`, 0–100), so the game looks identical at any screen size. Frame steps are capped at 50ms so a backgrounded tab can't teleport the tiles. Visual effects respect `prefers-reduced-motion`.

## Deployment

Every push to `main` runs `.github/workflows/deploy.yml`, which runs the tests, builds the site and publishes it to GitHub Pages.
