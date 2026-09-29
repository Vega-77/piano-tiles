# Piano Tiles

A mobile-responsive Piano Tiles clone with a rhythm twist. Pick a song and a full backing track (melody, drums, bass and chords) plays continuously while tiles fall down four lanes in time with it. Tap each tile as it lines up with the timing bar: the closer, the more points, and a run of perfects multiplies everything. Every time the song ends it comes round again, much faster.

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
- The board scrolls in over a short count-in before the first tile arrives.
- Tiles come in rhythm, so there are **gaps**: rows with nothing to tap. Wait through them.
- Tap a lane with no tile in it, leave a tile too long, or tap one far too early, and it's over.
- The game pauses itself if you switch tabs.

### The timing bar

The glowing bar is where the **middle of each tile** should be when you tap it. The gold band is the perfect zone and the wider soft band is the good zone.

| Tap | Points |
| --- | --- |
| **Perfect** (within 75 ms of the bar) | 100 |
| **Good** (within 150 ms), early or late | 60 |
| **OK** (within 250 ms), early or late | 25 |
| **Further off than that** | The tile doesn't line up with the bar: **game over** |

Timing is measured in seconds, not pixels, so the windows stay fair however fast the tiles fall. The bar's zones grow as the tiles speed up so they always show what the windows actually are. Tapping before the next tile has scrolled into view is simply ignored.

### Chains

Each perfect extends your **chain**; anything less resets it to zero. Every 8 perfects in a row adds 1 to the points multiplier, up to ×8, and the multiplier applies to every point you score after that. The chain shows under the score.

### The music

Each song is a whole arrangement: a lead melody, kick, snare and hi-hats, a bass line and chords. It plays continuously on its own, scheduled on the audio clock, and **never reacts to your taps**, so when you tap has no effect on what you hear. Tiles arrive at the bar exactly on the melody's beats, and the drums and bass keep going through the gaps. A few soft ticks count you in.

### Laps and speed

Every song opens at a brisk tempo of its own. Each time the song finishes a lap, the tiles **and the tempo** jump to 1.3× the previous lap's speed: 1.0×, 1.3×, 1.69×, 2.2×, 2.86×, and so on. The multiplier is `LAP_SPEED_FACTOR ** lap` in `src/config.ts`.

### Tile types

| Tile | What to do |
| --- | --- |
| **Tap** | Tap it as it lines up with the bar. |
| **Double** | Two tiles in the same row, exactly one lane apart (lanes 1 & 3, or 2 & 4), joined by a glowing bar. Tap both, in either order; each is graded on its own. |
| **Hold** (gold, 2–4 rows tall) | Press as its head lines up with the bar (graded like a tap) and keep holding. It pays out a tick every half row for as long as you hold, worth more the longer it is. **Letting go early never ends the game**: you just stop earning ticks. Tapping the next tile also lets go of the hold. |

Best score, best chain and most laps are saved per song in `localStorage`.

## Songs

| Song | Difficulty | BPM | Features |
| --- | --- | --- | --- |
| Twinkle Twinkle Little Star | Beginner | 112 | Gaps, holds |
| Ode to Joy | Easy | 132 | Gaps, holds |
| Für Elise | Medium | 80 | Gaps, holds, doubles |
| Rondo Alla Turca | Hard | 90 | Gaps, holds, doubles |
| In the Hall of the Mountain King | Expert | 102 | Gaps, holds, doubles |

Songs live in `src/songs/songs.ts`, written bar by bar on an eighth-note grid (one row = one eighth note). The melody uses these tokens, with bars ended by `|` or a new line:

```
E4        a tap tile (one row)
C4+E4     a double: two tiles at once (plays both notes)
G4~       a hold tile, 2 rows tall
G4~3      a hold tile, 3 rows tall (2–4 allowed)
.         a rest: one row with nothing to tap
.3        a rest three rows long
```

Every song also gives one chord per bar (two joined with `/` to change halfway) and a **groove**: a drum, bass and chord pattern with one character per row of the bar, for example `kick: 'x...x...'`, `bass: '1...5...'` (`1` root, `5` fifth, `8` octave). To add a song, append an entry with a title, composer, `difficulty` (1–5), `bpm`, `rowsPerBeat`, `rowsPerBar`, two theme hues, `notes`, `chords` and a `groove`. The loader refuses a bar that doesn't add up, and the tests check that every song is well formed, has gaps, plays as a full band, and starts at a proper pace.

## Adding songs

Drop in an mp4 (or mp3, m4a, wav, ogg, flac, mov, webm, anything with an audio track) and the tiles are laid out on its beat. The original recording plays instead of the built-in synth, and each lap it plays 1.3× faster along with the tiles (the pitch rises with it).

Adding a song needs the game running on **your own computer**. The published site is static, so it can play the songs that are committed to the repo but has nowhere to send a new file.

**One-time setup** (needs [Python 3.10+](https://www.python.org/downloads/); it installs librosa and a bundled ffmpeg into `tools/.venv`, nothing system-wide):

```bash
npm run setup:songs
```

**Then, each song:**

1. `npm run dev`
2. Drop the file anywhere on the song list (or click **Add a song**). The analysis takes a few seconds to a minute, depending on the length.
3. The new song appears in the list. Play it. If it doesn't feel right, open **Tune this song** on its card (below).
4. Commit `public/songs/` (`git add public/songs`). That folder holds the compressed audio and a small `chart.json` per song, so nobody has to analyse the file again, and the next deploy plays it.

**Options for the next song** (under the drop zone): a name (otherwise it comes from the file name), a tempo if you know it, and how many tiles (Easy, Normal, Busy).

### How the tiles are placed

The analyser finds the tempo and where the first beat falls, then puts the tiles on a fixed grid from there. It looks for sudden jumps in the sound (it doesn't tell instruments apart) and puts a tile on the strongest hits that fall on the grid, keeping a gap between tiles and leaving rests where the music is quiet. A hit followed by sustained sound with nothing struck over it becomes a hold, and the hardest hits, where the low, middle and high of the sound all land together, can become doubles. It does not transcribe the melody, so the tiles follow the *rhythm* rather than the notes.

That works best on music with a steady beat: pop, rock, electronic, hip-hop. Music that speeds up and slows down (live playing, classical rubato) can't sit on a fixed grid, and the analyser says so with a warning on the song.

### Tune this song

Every added song has a **Tune this song** panel, which saves straight into the song's files:

| Control | Use it when |
| --- | --- |
| **Sync** slider (±250 ms) | The tiles reach the bar a little before or after the beat you hear. Bluetooth speakers and headphones add delay of their own, so this is often the first thing to try. |
| **Tempo** + **Re-chart** | The tiles drift away from the music, or the detected tempo is half or double the real one. Type the right BPM. **Detect the tempo again** goes back to automatic. |
| **Easy / Normal / Busy** + **Re-chart** | There are too many or too few tiles. |
| **Name** + **Save** | To rename it. |
| **Remove song…** | To take it out (asks first). |

### Notes

- Only add music you have the right to share. This repo is public and `public/songs/` is published with the site.
- Up to 300 MB per file. Only one song is analysed at a time.
- The tools only run under `npm run dev`, and only answer requests from the game page on your own machine. `npm run build` and `npm run preview` don't include them.
- The deploy workflow doesn't need Python: it only publishes the committed songs. `npm run test:analyzer` runs the analyser's own checks on generated music (about a minute; it is not part of `npm test`).

## How it works

The 60fps loop lives outside React so per-frame movement never triggers a render, and **one clock rules everything: the audio clock.**

- `Timeline` says when every row of the song reaches the bar (and how the tempo steps up each lap).
- Each frame the engine reads the clock and places every tile from it, so a tile's position is a pure function of time.
- The whole backing track is scheduled ahead on that same clock, row by row, so tiles and audio can't drift apart.
- A tap is graded only by `tap time − the time its tile was centred on the bar`.
- Pausing suspends the audio clock, which freezes tiles and music together.

| File | Role |
| --- | --- |
| `src/game/timeline.ts` | The song clock: row arrival times, scroll position, lap speed-ups |
| `src/game/engine.ts` | Frame loop, beat layout (gaps included), tap/double/hold rules, judgments, chains, laps |
| `src/game/renderer.ts` | Owns the tile DOM nodes; positions are written straight to `transform` |
| `src/game/effects.ts` | Canvas visuals: animated backdrop, the timing bar, hit bursts, ripples, popups, banners |
| `src/game/audio.ts` | Web Audio synth: piano-ish lead, kick, snare, hats, bass, chord stabs and pad |
| `src/game/storage.ts` | Per-song best score, chain and laps |
| `src/songs/` | Song library, note-notation parser, the arrangement builder that turns melody + chords + groove into a full track, and the loader for songs added from recordings (`chart.ts`, `library.ts`, `importer.ts`) |
| `tools/` | Adding songs, dev only: the Python analyser (`analyze.py`), and the Vite plugin that connects the page to it (`songs-plugin.ts`, `songs-bridge.ts`, `songs-files.ts`) |
| `src/hooks/useGame.ts` | Bridges the engine to React; state updates only on start, each score, each lap, pause and game over |
| `src/index.css` | Tile looks and animations, switched by `data-kind` / `data-state` attributes |
| `src/config.ts` | Tunables: timing windows, points, chain steps, lap speed factor |

Tile positions are percentages of board height (`yPos`, 0–100), so the game looks identical at any screen size. Visual effects respect `prefers-reduced-motion`.

## Deployment

Every push to `main` runs `.github/workflows/deploy.yml`, which runs the tests, builds the site and publishes it to GitHub Pages.
