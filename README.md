# Piano Tiles

A mobile-responsive Piano Tiles clone with a rhythm twist. Pick a song and it plays continuously while tiles fall down four lanes in time with it. Tap each tile as it lands on the timing bar: the closer to the bar, the more points, and a run of perfects multiplies everything. Every time the song ends, it comes round again, much faster.

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

- **Touch / mouse:** tap in a lane to hit the next tile in that lane. Where you tap in the lane doesn't matter, only when.
- **Keyboard:** `D` `F` `J` `K` are lanes 1–4. `Esc` pauses.
- The board scrolls in for a couple of seconds before the first tile arrives.
- Tap a tile that isn't next, or a lane with no tile, or leave a tile untapped too long, and it's over.
- The game pauses itself if you switch tabs.

### The timing bar

The glowing bar near the bottom is where each tile should be when you tap it: line the tile's **leading edge up with the bar**. The gold band is the perfect zone and the wider soft band is the good zone.

| Tap | Points |
| --- | --- |
| **Perfect** (within 80 ms of the bar) | 100 |
| **Good** (within 160 ms), early or late | 60 |
| **OK** (anything else, early or late) | 25 |

Timing is measured in seconds, not pixels, so the windows stay fair however fast the tiles fall. The bar's zones grow as the tiles speed up so they always show what the windows actually are.

### Chains

Each perfect extends your **chain**; anything less resets it to zero. Every 8 perfects in a row adds 1 to the points multiplier, up to ×8, and the multiplier applies to every tile after that. The chain shows under the score.

### The music

The song plays continuously on its own, scheduled on the audio clock. Tiles arrive at the bar exactly on the beat, but tapping doesn't trigger any notes, so when you tap has no effect on what you hear. Late or early taps cost points, never the tune.

### Laps and speed

Each time the song finishes a lap, the tiles **and the tempo** jump to 1.3× the previous lap's speed: 1.0×, 1.3×, 1.69×, 2.2×, 2.86×, and so on. The multiplier is `LAP_SPEED_FACTOR ** lap` in `src/config.ts`.

### Tile types

| Tile | What to do |
| --- | --- |
| **Tap** (single) | Tap it as it reaches the bar. |
| **Double** | Two tiles in the same row, exactly one lane apart (lanes 1 & 3, or 2 & 4), joined by a glowing bar. Tap both, in either order; each is graded on its own. |
| **Hold** (gold, 2–4 rows tall) | Press as its head reaches the bar and keep holding until its tail reaches the bar, then let go (a fraction of a second early is forgiven). Finishing a hold earns a bonus of 50 × your multiplier. |

Best score, best chain and most laps are saved per song in `localStorage`.

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

To add one, append an entry with a title, composer, `difficulty` (1–5), `speed` (percent of board height per second on the first lap), two theme hues, and its `notes`. A song loops for as long as you survive. The tests check that every song parses and stays within the rules.

## How it works

The 60fps loop lives outside React so per-frame movement never triggers a render, and **one clock rules everything: the audio clock.**

- `Timeline` says when every beat of the song reaches the bar (and how the tempo steps up each lap).
- Each frame the engine reads the clock and places every tile from it, so a tile's position is a pure function of time.
- The music for upcoming beats is scheduled ahead on that same clock, so tiles and audio can't drift apart.
- A tap is graded only by `tap time − the time its tile reached the bar`.
- Pausing suspends the audio clock, which freezes tiles and music together.

| File | Role |
| --- | --- |
| `src/game/timeline.ts` | The song clock: beat arrival times, scroll position, lap speed-ups |
| `src/game/engine.ts` | Frame loop, beat layout, tap/double/hold rules, judgments, chains, laps |
| `src/game/renderer.ts` | Owns the tile DOM nodes; positions are written straight to `transform` |
| `src/game/effects.ts` | Canvas visuals: animated backdrop, the timing bar, hit bursts, ripples, popups, banners |
| `src/game/audio.ts` | Web Audio piano-style synth; schedules the song on the audio clock |
| `src/game/storage.ts` | Per-song best score, chain and laps |
| `src/songs/` | Song library and the note-notation parser |
| `src/hooks/useGame.ts` | Bridges the engine to React; state updates only on start, each score, each lap, pause and game over |
| `src/index.css` | Tile looks and animations, switched by `data-kind` / `data-state` attributes |
| `src/config.ts` | Tunables: timing windows, points, chain steps, lap speed factor |

Tile positions are percentages of board height (`yPos`, 0–100), so the game looks identical at any screen size. Visual effects respect `prefers-reduced-motion`.

## Deployment

Every push to `main` runs `.github/workflows/deploy.yml`, which runs the tests, builds the site and publishes it to GitHub Pages.
