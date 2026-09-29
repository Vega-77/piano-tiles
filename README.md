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

It all happens **in the browser, on the device you are holding**. There is nothing to install and no command to run, so it works the same on the published site, on a phone, or on a computer you have never used before:

1. Drop the file anywhere on the song list, or tap **Add a song** and choose it. The listening takes a few seconds for a typical song (a progress bar shows how far along it is, with a Cancel button).
2. The new song appears in the list. Play it. If it doesn't feel right, open **Tune this song** on its card (below).

The file never leaves the device: it isn't uploaded anywhere, and it isn't added to this repository.

**Options for the next song** (under the drop zone): a name (otherwise it comes from the file name), a tempo if you know it, and how many tiles (Easy, Normal, Busy).

### Where songs are kept

A song (its chart and its audio) is saved in that browser's own storage (IndexedDB), so it is still there next time, but **only on that device and in that browser**. To play it somewhere else, open **Tune this song → Save song file**, which downloads a `.pianotiles` file with the song, its audio and its tuning in one. On the other device, choose that file with **Add a song** (or drop it on the list). The song comes back exactly as it was, with no listening needed. Adding the same file again replaces that song; a different song with the same name gets a name of its own.

Clearing a site's data removes its songs, and a private window forgets them when it closes (the game says so when the browser won't keep them). Save the song files of anything you would miss.

### How the tiles are placed

The analyser finds the tempo and where the first beat falls, then puts the tiles on a fixed grid from there. It looks for sudden jumps in the sound (it doesn't tell instruments apart) and puts a tile on the strongest hits that fall on the grid, keeping a gap between tiles and leaving rests where the music is quiet. A hit followed by sustained sound with nothing struck over it becomes a hold, and the hardest hits, where the low, middle and high of the sound all land together, can become doubles. It does not transcribe the melody, so the tiles follow the *rhythm* rather than the notes.

That works best on music with a steady beat: pop, rock, electronic, hip-hop. Music that speeds up and slows down (live playing, classical rubato) can't sit on a fixed grid, and the analyser says so with a warning on the song.

### Tune this song

Every added song has a **Tune this song** panel. Changes are saved on this device straight away.

| Control | Use it when |
| --- | --- |
| **Sync** slider (±250 ms) | The tiles reach the bar a little before or after the beat you hear. Bluetooth speakers and headphones add delay of their own, so this is often the first thing to try. |
| **Tempo** + **Re-chart** | The tiles drift away from the music, or the detected tempo is half or double the real one. Type the right BPM. **Detect the tempo again** goes back to automatic. |
| **Easy / Normal / Busy** + **Re-chart** | There are too many or too few tiles. |
| **Name** + **Save** | To rename it. |
| **Save song file** | To take the song to another device, or keep a backup. |
| **Remove song…** | To take it out of this device (asks first). |

### Notes

- Up to 300 MB per file and about ten minutes of music. Only one song is worked on at a time.
- A small mp3, m4a, aac or wav is kept as it came. A video, or anything else the browser might not play back, is stored as just its sound (a WAV, so a long video takes more room than the mp4 did).
- The browser has to be able to decode the file. mp3, m4a/mp4 and wav work everywhere; ogg, flac, webm and mov depend on the browser, and the game says so if it can't read one.
- Only add music you have the right to use. Nothing is uploaded or published, but songs you add are yours to answer for.

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
| `src/songs/` | Song library, note-notation parser, and the arrangement builder that turns melody + chords + groove into a full track |
| `src/songs/analysis/` | The in-browser analyser for added songs: spectral onsets, tempo and beat grid, tile placement (`analyze.ts` and friends), run in a worker (`analyzer.worker.ts`, `client.ts`) |
| `src/songs/` (added songs) | `decode.ts` reads a file's audio, `importer.ts` adds / re-charts / tunes / removes a song, `store.ts` keeps songs in IndexedDB, `bundle.ts` is the `.pianotiles` song file, `chart.ts` and `library.ts` turn stored charts into playable songs |
| `src/hooks/useGame.ts` | Bridges the engine to React; state updates only on start, each score, each lap, pause and game over |
| `src/index.css` | Tile looks and animations, switched by `data-kind` / `data-state` attributes |
| `src/config.ts` | Tunables: timing windows, points, chain steps, lap speed factor |

Tile positions are percentages of board height (`yPos`, 0–100), so the game looks identical at any screen size. Visual effects respect `prefers-reduced-motion`.

## Deployment

Every push to `main` runs `.github/workflows/deploy.yml`, which runs the tests, builds the site and publishes it to GitHub Pages.
