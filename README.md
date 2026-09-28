# Piano Tiles

A mobile-responsive Piano Tiles clone. Tap the black tiles as they fall down four lanes. The game speeds up as you go, and ends if you miss a tile or tap a white one.

**Stack:** React 19, TypeScript, Vite 8, Tailwind CSS 4, Web Audio API.

## Run it

Requires Node.js 20.19+ (or 22.12+).

```bash
npm install
npm run dev      # dev server at http://localhost:5173
npm run build    # type-check + production build into dist/
npm run preview  # serve the production build
```

## How to play

- **Touch / mouse:** tap the black tile in the lowest row.
- **Keyboard:** `D` `F` `J` `K` are lanes 1–4.
- The first tile waits for your tap before the board starts moving.
- Each hit plays the next note of *Ode to Joy*. Your best score is saved in `localStorage`.

## How it works

The 60fps loop lives outside React so per-frame movement never triggers a render.

| File | Role |
| --- | --- |
| `src/game/engine.ts` | `requestAnimationFrame` loop, tile spawning, hit/miss rules, speed ramp |
| `src/game/renderer.ts` | Owns the tile DOM nodes; positions are written straight to `transform` |
| `src/game/audio.ts`, `melody.ts` | Web Audio piano-style synth and the note sequence |
| `src/game/storage.ts` | High score persistence |
| `src/hooks/useGame.ts` | Bridges the engine to React; state updates only on start, each hit, and game over |
| `src/config.ts` | Tunables: base speed, speed step (+0.05 per 50 tiles), tile height |

Tile positions are percentages of board height (`yPos`, 0–100), so the game looks identical at any screen size. Frame steps are capped at 50ms so a backgrounded tab can't teleport the tiles.
