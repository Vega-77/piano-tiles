# Piano Tiles

A mobile-responsive Piano Tiles clone with a rhythm twist. Add a song of your own (an mp4 or any audio file) and it plays continuously while tiles fall down four lanes in time with its beat. Tap each tile as it lines up with the timing bar: the closer, the more points, and a run of perfects multiplies everything. Every time the song ends it comes round again, faster.

There are no songs built in: the game starts empty, and the songs are the ones you add (see [Adding songs](#adding-songs)).

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
- The board scrolls in over a short count-in before the first tile arrives, and every later lap starts with a break and another count-in (see below).
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

The song is the original recording. It plays continuously, on the audio clock, and **never reacts to your taps**, so when you tap has no effect on what you hear. Tiles arrive at the bar on the beats the analyser found, and the music keeps going through the gaps. A count-in of four beats, with a big 4-3-2-1 on screen, comes before the first tile.

### Laps and speed

Every song opens at a brisk tempo of its own. Each time the song finishes a lap, the tiles **and the tempo** speed up by another 0.2× of the *first* lap's speed: 1.0×, 1.2×, 1.4×, 1.6×, 1.8×, and so on. It is added, not compounded, so lap *n* runs at `1 + LAP_SPEED_STEP × n` (`LAP_SPEED_STEP` is in `src/config.ts`).

**A break before every jump.** The last tiles of a lap scroll away, then there is a short rest (`LAP_REST_SECONDS`, 1.5 s at the new speed), then four beats of count-in at the *new* tempo, so you hear the speed you are about to play at before the first tile arrives. The new lap's banner and speed show at the start of the break, and nothing can be missed during it.

### Tile types

| Tile | What to do |
| --- | --- |
| **Tap** | Tap it as it lines up with the bar. |
| **Double** | Two tiles in the same row, exactly one lane apart (lanes 1 & 3, or 2 & 4), joined by a glowing bar. Tap both, in either order; each is graded on its own. |
| **Hold** (gold, 2–4 rows tall) | Press as its head lines up with the bar (graded like a tap) and keep holding. It pays out a tick every half row for as long as you hold, worth more the longer it is. **Letting go early never ends the game**: you just stop earning ticks. Tapping the next tile also lets go of the hold. |

Best score, best chain and most laps are saved per song in `localStorage`.

## Adding songs

The game has no songs of its own: you add them. Drop in an mp4 (or mp3, m4a, wav, ogg, flac, mov, webm, anything with an audio track) and the tiles are laid out on its beat. The original recording plays, and each lap it plays faster along with the tiles (the pitch rises with it).

It all happens **in the browser, on the device you are holding**. There is nothing to install and no command to run, so it works the same on the published site, on a phone, or on a computer you have never used before:

1. Drop the file anywhere on the song list, or tap **Add your own song** and choose it. The listening takes a few seconds for a typical song (a progress bar shows how far along it is, with a Cancel button).
2. The new song appears in the list, charted at Medium. Play it. If it doesn't feel right, tap **Tune** on the "Added" message, or **Tune this song** under the song's card (below).

The file never leaves the device: it isn't uploaded anywhere, and it isn't added to this repository.

The song list is only for picking. Everything technical (name, sync, tempo, how many tiles) lives on the separate **Tune** screen.

### Where songs are kept

A song (its chart and its audio) is saved in that browser's own storage (IndexedDB), so it is still there next time, but **only on that device and in that browser**. To play it somewhere else, open **Tune this song**, then **Save song file**, which downloads a `.pianotiles` file with the song, its audio and its tuning in one. On the other device, choose that file with **Add your own song** (or drop it on the list). The song comes back exactly as it was, with no listening needed. Adding the same file again replaces that song; a different song with the same name gets a name of its own.

Clearing a site's data removes its songs, and a private window forgets them when it closes (the game says so when the browser won't keep them). Save the song files of anything you would miss.

### How the tiles are placed

The analyser finds the tempo and where the first beat falls, then puts the tiles on a fixed grid from there. It looks for sudden jumps in the sound (it doesn't tell instruments apart) and puts a tile on the strongest hits that fall on the grid, keeping a gap between tiles and leaving rests where the music is quiet.

The tiles are spread with a **quota per stretch of music**: every eight beats gets a share of the tiles (about 60% of what the difficulty allows, taken from that stretch's own strongest hits), and only what is left over goes to the loudest hits anywhere. That is what keeps a quiet verse from being emptied out by a loud chorus, while a truly silent stretch (a break, a fade) still gets none. A chorus still ends up busier than a verse, because it has more strong hits to choose from. Hits that land on the beat are slightly preferred. A hit followed by sustained sound with nothing struck over it becomes a hold, and the hardest hits, where the low, middle and high of the sound all land together, can become doubles. It does not transcribe the melody, so the tiles follow the *rhythm* rather than the notes.

That works best on music with a steady beat: pop, rock, electronic, hip-hop. Music that speeds up and slows down (live playing, classical rubato) can't sit on a fixed grid, and the analyser says so with a warning on the song.

### Tune this song

Every added song has a **Tune** screen of its own, opened with **Tune this song** (it appears under the song you have selected) or the **Tune** button on the "Added" message. **Songs** or `Esc` goes back to the list; **Try it** plays the song, and quitting the game brings you back to the Tune screen so you can adjust and try again.

| Control | Use it when |
| --- | --- |
| **Sync** slider (±250 ms) + **Save** | The tiles reach the bar a little before or after the beat you hear. Bluetooth speakers and headphones add delay of their own, so this is often the first thing to try. |
| **Tempo** | The tiles drift away from the music, or the detected tempo is half or double the real one. Type the right BPM, then **Re-chart**. **Find the tempo again** goes back to automatic. |
| **Easy / Medium / Hard** + **Re-chart** | There are too many or too few tiles. Easy leaves a free row between tiles; Medium and Hard allow tiles in neighbouring rows, with Hard the fullest (and the most doubles). **Re-chart** is always available, so you can also use it to lay the tiles out again with the latest analyser without changing anything else. A song keeps the tiles it has until you re-chart it, so songs added before the levels moved up one keep their old tiles until then. |
| **Name** + **Save** | To rename it. |
| **Save song file** | To take the song to another device, or keep a backup. |
| **Remove song…** | To take it out of this device (asks first). |

Changes are saved on this device straight away.

### Notes

- Up to 300 MB per file and about ten minutes of music. Only one song is worked on at a time.
- A small mp3, m4a, aac or wav is kept as it came. A video, or anything else the browser might not play back, is stored as just its sound (a WAV, so a long video takes more room than the mp4 did).
- The browser has to be able to decode the file. mp3, m4a/mp4 and wav work everywhere; ogg, flac, webm and mov depend on the browser, and the game says so if it can't read one.
- Only add music you have the right to use. Nothing is uploaded or published, but songs you add are yours to answer for.

## How it works

The 60fps loop lives outside React so per-frame movement never triggers a render, and **one clock rules everything: the audio clock.**

- `Timeline` says when every row of the song reaches the bar (and how the tempo steps up each lap).
- Each frame the engine reads the clock and places every tile from it, so a tile's position is a pure function of time.
- The recording plays on that same clock (its playback rate steps up with each lap), so tiles and audio can't drift apart.
- A tap is graded only by `tap time − the time its tile was centred on the bar`.
- Pausing suspends the audio clock, which freezes tiles and music together.

| File | Role |
| --- | --- |
| `src/game/timeline.ts` | The song clock: row arrival times, scroll position, lap speed-ups and the rest and count-in before each lap |
| `src/game/engine.ts` | Frame loop, beat layout (gaps included), tap/double/hold rules, judgments, chains, laps |
| `src/game/renderer.ts` | Owns the tile DOM nodes; positions are written straight to `transform` |
| `src/game/effects.ts` | Canvas visuals: animated backdrop, the timing bar, hit bursts, ripples, popups, banners |
| `src/game/audio.ts` | Web Audio: plays a song's recording at each lap's speed. It also has a small synth (lead, drums, bass, chords) for a song that has notes instead of a recording, which the tests use |
| `src/game/storage.ts` | Per-song best score, chain and laps |
| `src/songs/` | Note-notation parser and the arrangement builder (used by the synth path and the tests), and `songs.ts`, the numbers the screens show about a song |
| `src/songs/analysis/` | The in-browser analyser for added songs: spectral onsets, tempo and beat grid, tile placement (`analyze.ts` and friends), run in a worker (`analyzer.worker.ts`, `client.ts`) |
| `src/songs/` (added songs) | `decode.ts` reads a file's audio, `importer.ts` adds / re-charts / tunes / removes a song, `store.ts` keeps songs in IndexedDB, `bundle.ts` is the `.pianotiles` song file, `chart.ts` and `library.ts` turn stored charts into playable songs |
| `src/components/` | The screens and overlays: song list (`SongSelect`, `ImportPanel`, `JobStatus`), the separate `TuneScreen`, the HUD, pause and game over |
| `src/hooks/useGame.ts` | Bridges the engine to React; state updates only on start, each score, each lap, pause and game over |
| `src/index.css` | Tile looks and animations, switched by `data-kind` / `data-state` attributes |
| `src/config.ts` | Tunables: timing windows, points, chain steps, lap speed step |

Tile positions are percentages of board height (`yPos`, 0–100), so the game looks identical at any screen size. Visual effects respect `prefers-reduced-motion`.

## Deployment

Every push to `main` runs `.github/workflows/deploy.yml`, which runs the tests, builds the site and publishes it to GitHub Pages.
