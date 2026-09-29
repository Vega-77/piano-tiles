# Piano Tiles

A mobile-responsive Piano Tiles clone with a rhythm twist. A song plays continuously while tiles fall down four lanes in time with its beat. Tap each tile as it lines up with the timing bar: the closer, the more points, and a run of perfects multiplies everything. Every time the song ends it comes round again, faster.

The songs are published in a shared database, so they are there to play on any device, and each has a leaderboard you can put a nickname on. Adding a song (from an mp4 or any audio file) is done by the owner in the app itself, once, and everyone plays that one chart (see [Songs, and who can add them](#songs-and-who-can-add-them)).

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

- **Touch / mouse:** tap in a lane to hit the next tile in that lane. Where you tap in the lane doesn't matter, only when. Every finger counts on its own, so doubles are played with two fingers (and double holds too, if they are switched back on); a mouse has only one pointer, so use the keyboard (or a touchscreen) for a double.
- **Keyboard:** `D` `F` `J` `K` are lanes 1–4. `Esc` pauses.
- The board is empty through a four-beat count-in (a big 4-3-2-1, with a tick on each beat) before the first tile arrives, and every later lap starts with a break and another count-in (see below).
- Tiles come in rhythm, so there are **gaps**: rows with nothing to tap. Wait through them.
- Tap a lane with no tile in it, leave a tile too long, or tap one far too early, and it's over.
- The game pauses itself if you switch tabs.
- **Resuming counts you back in.** After a pause, the music and tiles stay frozen until a four-beat 4-3-2-1 has played out at the tempo you were playing at, ticking on the beat. Taps are ignored while it counts. Pausing again mid-count starts the count over.
- **Touches not doing what they should?** Add `?input` to the end of the game's address (`…/piano-tiles/?input`). A small readout at the bottom shows every finger that goes down, comes up or is cancelled by the browser, and how many are down, so it can be seen whether the screen is sending what the game expects. Under each finger it says what the game made of the tap (`tap L3: good +120ms`: which lane, the grade, and how early (−) or late (+) it was; or why it was ignored), any frame that took long (`slow frame`), and the audio's delay to the speaker. A finger the page only heard of late says so (`down (heard 480ms late) touch …`), and when a double, a hold or a double hold comes due it says so (`due: double hold in L0 and L2`), so the fingers can be lined up against the moment they were asked for. A screenshot of it, with the game over text, says what went wrong.

### The timing bar

The glowing bar is where the **middle of each tile** should be when you tap it. The gold band is the perfect zone and the wider soft band is the good zone.

| Tap | Points |
| --- | --- |
| **Perfect** (within 100 ms of the bar) | 100 |
| **Good** (within 180 ms), early or late | 60 |
| **OK** (within 250 ms), early or late | 25 |
| **Further off than that** | The tile doesn't line up with the bar: **game over** |

**Double holds are switched off for now** (`DOUBLE_HOLDS` in `src/config.ts`): they did not make the game better. The analyser lays none, and a chart that has some (the published songs do) plays each as an ordinary hold of the same length, so nothing moves and no song needs re-charting. Everything for them is still in the game and the notation; setting `DOUBLE_HOLDS` to `true` brings them back.

**Double holds get longer to be grabbed late.** (While they are on.) They are the hardest tile to get two fingers onto, so both halves may still be grabbed up to 500 ms after the bar (as an OK); every other tile is missed after 250 ms. Early, a double hold is as strict as any tile.

A Good or OK hit also shows a coloured tag under its name, **blue EARLY** or **orange LATE**, so you can tell which way you missed; a perfect hit has none.

Timing is measured in seconds, not pixels, so the windows stay fair however fast the tiles fall. The bar's zones grow as the tiles speed up so they always show what the windows actually are. Tapping before the next tile has scrolled into view is simply ignored. A tap is graded at the moment the finger (or key) landed, not the moment the page got round to hearing of it, so a slow frame doesn't make a tap late. The game over screen says how many milliseconds early or late the tap was that ended the run.

The music is played so that what you *hear* is on the song clock, whatever the speaker's delay (a Bluetooth speaker or headphones can be a fifth of a second behind what the device hands over); the tiles are drawn on that same clock.

### Chains

Each perfect extends your **chain**. A good hit keeps the chain going without adding to it; a hit that is only OK resets it to zero. Every 5 perfects in a row adds 1 to the points multiplier, up to ×8, and the multiplier applies to every point you score after that. The chain shows under the score.

### The music

The song is the original recording. It plays continuously, on the audio clock, and **never reacts to your taps**, so when you tap has no effect on what you hear. Tiles arrive at the bar on the beats the analyser found, and the music keeps going through the gaps. A count-in of four beats, with a big 4-3-2-1 on screen and a tick on every beat, comes before the first tile. The first tile lands on the beat right after the "1": the analyser puts the first row of a song on a beat, so the count-in and the music share one pulse.

### Laps and speed

Every song opens at a brisk tempo of its own. Each time the song finishes a lap, the tiles **and the tempo** speed up by another 0.2× of the *first* lap's speed: 1.0×, 1.2×, 1.4×, 1.6×, 1.8×, and so on. It is added, not compounded, so lap *n* runs at `1 + LAP_SPEED_STEP × n` (`LAP_SPEED_STEP` is in `src/config.ts`).

**A break before every jump.** The last tiles of a lap scroll away, then there is a short rest (`LAP_REST_SECONDS`, 1.5 s at the new speed), then four beats of count-in at the *new* tempo (each beat is one beat of the song at its new speed, so the count keeps time with the music you're about to play), so you hear the speed you are about to play at before the first tile arrives. The new lap's banner and speed show at the start of the break, and nothing can be missed during it.

**A lap is 60–90 seconds.** A song longer than that is stopped at a chosen point each lap, with the music fading out, and starts again from the top (see [Length](#tune-this-song)). A song that already fits plays whole.

### Tile types

| Tile | What to do |
| --- | --- |
| **Tap** | Tap it as it lines up with the bar. |
| **Double** | Two tiles in the same row, exactly one lane apart (lanes 1 & 3, or 2 & 4), joined by a glowing bar. Tap both, in either order; each is graded on its own. Common at every level: up to about one tile in eight on Easy, one in five on Medium and more than one in four on Hard. |
| **Hold** (gold, 2–4 rows tall) | Press as its head lines up with the bar (graded like a tap) and keep holding. It pays out a tick every half row for as long as you hold, worth more the longer it is. **Letting go early never ends the game**: you just stop earning ticks. Tapping the next tile also lets go of the hold. |
| **Double hold** (switched off for now, see above; a chart's are played as plain holds) | Two holds in the same row, one lane apart, joined by the glowing bar at their heads. Press both heads (each is graded on its own) and keep both down; each pays its own ticks, and lifting one finger early only stops that one (the other is still the one being held, so the next tile can be tapped without ending the run). Rarer than the other tiles: about a quarter to two-fifths of a song's holds, never two within 16 rows. |

Best score, best chain and most laps are saved per song in `localStorage`, and a run's score also goes on the song's [leaderboard](#leaderboards-and-nicknames).

## Songs, and who can add them

The songs everyone plays are **published**: they live in a shared Firebase database, and every device brings a copy onto itself when the page opens. Open the game and they are there, on any device, with nothing to install and no command to run. A song's chart (a small piece of JSON) arrives at once and its audio (the big part) is downloaded the first time the song is played, with a progress figure on the Play button. After that the song is stored in that browser (IndexedDB), so it plays offline.

**One song has one chart.** A song is analysed once, by whoever adds it, and that one chart is what everyone plays. Nobody else's device works it out again, so everybody's tiles are the same, and so are their scores.

**Adding a song is for the owner only.** Everyone else sees no add or tune controls. The owner is whoever is listed in the database's `admins` collection (see [Setting it up](#setting-it-up-once-in-the-firebase-console)). This is decided by the database's rules, not by the page, so it can't be got around by editing the page: a typed password would sit in the page's code where anyone can read it, and a check that lives in the page can't keep anyone out of a database that is open to the internet.

### Publishing songs (admin)

Once signed in with the admin's Google account the song list shows the tools. It all happens **in the browser, on the device you are holding**: no install, no command.

1. Drop an mp4 (or mp3, m4a, wav, ogg, flac, mov, webm, anything with an audio track) anywhere on the song list, or tap **Add your own song** and choose it. The listening takes a few seconds for a typical song (a progress bar shows how far along it is, with a Cancel button). The tiles are laid out on the beat, and the song appears as a **Draft**: it is on this device only, and only the admin sees it.
2. Play it. If it doesn't feel right, **Tune** it (below), re-chart it, try again.
3. On the Tune screen, **Publish**. The audio goes up first and then the chart, so a song is never in the database without its sound. Everyone has it the next time they open the game (or return to the page).
4. Changed a published song? The card says **Unpublished changes**; **Update the published song** replaces the one chart. **Take it down…** removes it for everyone (it stays on your device as a draft).

A song's badge says where it stands: **Draft** (never published), **Unpublished changes** (published, and changed since), **Published**.

The file being added is not stored anywhere but your device and, once you publish, the database. It is never added to this repository.

### Where songs are kept

A song (its chart and its audio) is saved in that browser's own storage (IndexedDB), so it is still there next time and plays offline, but **only in that browser**. For everyone but the admin that is just a cache of the published songs, which come back by themselves. For the admin, a draft exists only there until it is published, so to move a draft to another device, open **Tune this song**, then **Save song file**, which downloads a `.pianotiles` file with the song, its audio and its tuning in one. On the other device, choose that file with **Add your own song** (or drop it on the list). Adding the same file again replaces that song; a different song with the same name gets a name of its own.

Clearing a site's data removes its songs (the published ones come back at the next visit), and a private window forgets them when it closes (the game says so when the browser won't keep them).

### How devices stay in step

Each device keeps a copy of every published song and records, in the song's `publishedAt`, which published version the copy is. When the page opens, when the connection comes back, and when you return to the page after a minute or more, the device looks at the published songs and:

- adds a song it hasn't got (its chart; the audio comes when it is first played),
- brings a copy that is behind up to date,
- drops a copy of a song that was taken down,
- and never touches the admin's unpublished changes or drafts.

### Leaderboards and nicknames

Every published song has a leaderboard (the top ten, with your own place shown if you are below them). Nobody has to sign in to play, and nobody has to before their first run.

- **After a run**, a player with no nickname is asked for one. Choosing it makes them a **guest** (a Firebase anonymous account, made at that moment and not before), and their score goes on the board. The nickname and the guest account stay on that device for future runs.
- **Nicknames are unique** whatever their capitals (`Pat` and `pat` are the same name), 3–16 letters, numbers, `-` and `_`, and once taken are the account's for good. The database enforces it, not just the page: a nickname is a document that can only be created once.
- **Only after a run.** A score is sent for a song as it is published, when the run ends, and only if it beats the player's best on that song; the leaderboard keeps one entry per player per song. A run of zero isn't sent.
- **Keeping a nickname.** A guest lives only in that browser, so clearing the browser's data loses it (and the name stays taken). **Keep it with Google** (or **Sign in with Google**, for someone who has played before) under the title turns the guest into a Google account with the same nickname and scores, which then follows the player to other devices. Only a Google account can sign out.
- **What the rules keep out:** someone else's name, someone else's entry, a lowered score, extra fields, and absurd numbers (at most 100,000,000 points, 1,000 laps, a chain of 100,000). What they can't keep out is cheating: the game runs in the player's browser, so a determined player can send any score inside those limits. That is fine for friends; for a wide public it would need scores checked on a server, which is beyond the free plan.
- **Not there:** replays and ghosts.
- **Resetting the scores.** The owner, signed in with Google, opens a published song's tuning screen and taps **Reset the scores…** under *Leaderboard* to empty that song's board for everyone (nicknames stay, and players can put a new score on it at once). This is the one place a score is ever removed, and the rules let only an admin do it. A player's own bests are kept on their device, so a reset of those is a change of the key they are kept under (`piano-tiles:songs:v3`): the first time a device opens a version with a new key it starts from nothing, and the old record is cleared away. The last reset of both was on 2026-09-29.

Boards are read a few at a time and looked at again only after three minutes or after the player's own run, to stay inside the free daily reads.

### The free plan

It runs on Firebase's **free Spark plan**, using only **Authentication** (Google, and anonymous for guests) and **Firestore**. There is no Cloud Storage (it needs a card), no Cloud Functions, no Analytics, and nothing to pay. Firebase itself is only downloaded when the page opens the published songs (a few hundred KB, cached afterwards).

- **What is stored:** `songs/<id>` (a song's chart and where its audio is) with the audio in pieces of 900 KB under `songs/<id>/parts` (a document can be at most 1 MiB), `songs/<id>/scores/<uid>` (one entry per player), `players/<uid>` and `names/<nickname in lower case>` (nicknames), and `admins/<uid>`. The rules in [`firestore.rules`](firestore.rules) say who can read and write each.
- **Limits:** the free plan holds 1 GiB, allows about 50,000 reads and 20,000 writes a day, and about 10 GiB a month of downloads. A song's audio bigger than 40 MB can't be published. Downloading one 40 MB song is about 45 reads, and each device downloads it once; with friends that is comfortable, and a large public audience would need a paid plan (or audio hosted somewhere else). The game says so if the daily limit runs out.
- **The audio is publicly readable.** Anyone with the site's address can download the published audio. Only publish music you have the right to distribute, and keep in mind that a public database of copyrighted recordings can be reported. Songs you own or have licensed are the safe ones.
- **Old per-user sync:** an earlier version synced each signed-in user's own songs under `users/<uid>`. That is gone. Nothing reads that collection any more, and it can be deleted in the console.

### Setting it up once, in the Firebase console

The web config is public and lives in `src/cloud/config.ts` (it is not a secret; the rules are what protect the data). In the console for that project:

1. **Authentication → Sign-in method:** turn on **Google** and **Anonymous**. Under Settings → Authorized domains, add the site's domain (`vega-77.github.io`).
2. **Firestore Database:** create the database (production mode), then publish the contents of [`firestore.rules`](firestore.rules) under Rules.
3. **Make yourself the admin:** open the deployed game, tap **Sign in with Google** under the title, and sign in. The panel then shows an **Account id**: copy it. In Firestore, create a document in a collection called `admins` whose **Document ID** is that id (any field will do, for example `admin: true`). Reload the game and the tools appear. Keep the id out of the repository.

### How the tiles are placed

The analyser finds the tempo and where the first beat falls, then puts the tiles on a fixed grid from there. It looks for sudden jumps in the sound (it doesn't tell instruments apart) and puts a tile on the strongest hits that fall on the grid, keeping a gap between tiles and leaving rests where the music is quiet.

The tiles are spread with a **quota per stretch of music**: every eight beats gets a share of the tiles (about 60% of what the difficulty allows, taken from that stretch's own strongest hits), and only what is left over goes to the loudest hits anywhere. That is what keeps a quiet verse from being emptied out by a loud chorus, while a truly silent stretch (a break, a fade) still gets none. A chorus still ends up busier than a verse, because it has more strong hits to choose from. Hits that land on the beat are slightly preferred. A hit followed by sustained sound with nothing struck over it becomes a hold, and, only while `DOUBLE_HOLDS` is on (it is off for now), on the hits the most of the sound agrees on, some of the holds (25 % on Easy, 30 % on Medium, 40 % on Hard, at least one when there are two or more) become double holds, kept 16 rows apart. Doubles go on the hardest hits, where the low, middle and high of the sound all land together, and they are handed out through the song a stretch at a time (the same eight-beat stretches as the quota), so they turn up in every part of it rather than only in the loudest. They are capped at 12 % of the tiles on Easy, 20 % on Medium and 28 % on Hard, and never fall on two rows in a row. It does not transcribe the melody, so the tiles follow the *rhythm* rather than the notes.

The first row is placed on a beat, not wherever the recording happens to begin, so the count-in ticks and the lap's first tile share the song's pulse.

**Where a long song stops.** The analyser only ever lays out one lap. If the song is longer than the top of the chosen length (Short 60–70 s, Medium 70–80 s, Long 80–90 s), it looks at every bar line inside that range and picks the best place to stop. A bar line scores for ending a phrase (the end of eight bars beats four, four beats two, two beats one) and for falling in a quiet moment in the music, and the **later** bar line wins a tie, for more of the song. If not one bar line falls in the range (a very slow tempo), it stops at the top of the range. A song at or under the top plays whole. The audio file itself is kept whole, so re-charting at another length never needs it again, and the lap fades out at the stop.

That works best on music with a steady beat: pop, rock, electronic, hip-hop. Music that speeds up and slows down (live playing, classical rubato) can't sit on a fixed grid, and the analyser says so with a warning on the song.

### Tune this song

Only the admin sees this. Every added song has a **Tune** screen of its own, opened with **Tune this song** (it appears under the song you have selected) or the **Tune** button on the "Added" message. **Songs** or `Esc` goes back to the list; **Try it** plays the song, and quitting the game brings you back to the Tune screen so you can adjust and try again.

| Control | Use it when |
| --- | --- |
| **Sync** slider (±250 ms) + **Save** | The tiles reach the bar a little before or after the beat you hear. Bluetooth speakers and headphones add delay of their own, so this is often the first thing to try. |
| **Tempo** | The tiles drift away from the music, or the detected tempo is half or double the real one. Type the right BPM, then **Re-chart**. **Find the tempo again** goes back to automatic. |
| **Easy / Medium / Hard** + **Re-chart** | There are too many or too few tiles. Easy leaves a free row between tiles and has doubles now and then; Medium and Hard allow tiles in neighbouring rows, with Hard the fullest and the most doubles. **Re-chart** is always available, so you can also use it to lay the tiles out again with the latest analyser without changing anything else. A song keeps the tiles it has until you re-chart it, so songs added before the levels moved up one, or before doubles, double holds, lengths and the beat-aligned start, keep their old tiles until then. |
| **Short / Medium / Long** + **Re-chart** | The lap is too short or too long. Each is a range (60–70 s, 70–80 s, 80–90 s); a longer song is stopped at the best bar line inside it (see [Where a long song stops](#how-the-tiles-are-placed)). The screen says where this song would stop. Songs added before lengths existed play in full until re-charted. |
| **Name** + **Save** | To rename it. |
| **Publish** / **Update the published song** / **Take it down…** | To share the song with everyone, replace the one published chart with this one, or remove it for everyone (it stays here as a draft). |
| **Save song file** | To take a draft to another device, or keep a backup. |
| **Remove song…** | To take it out of this device (asks first). A published song stays published, and comes back at the next visit; take it down first to remove it for everyone. |

Changes are saved on this device straight away, and reach everyone only when you publish them.

### Notes

- Up to 300 MB per file and about ten minutes of music (that is what gets listened to; a lap is then cut to 60–90 s as above). Only one song is worked on at a time.
- A small mp3, m4a, aac or wav is kept as it came. A video, or anything else the browser might not play back, is stored as just its sound (a WAV, so a long video takes more room than the mp4 did).
- The browser has to be able to decode the file. mp3, m4a/mp4 and wav work everywhere; ogg, flac, webm and mov depend on the browser, and the game says so if it can't read one.
- Only add music you have the right to use. Nothing leaves your device until you press **Publish**, and a published song's audio can be downloaded by anyone (see [The free plan](#the-free-plan)).

## How it works

The 60fps loop lives outside React so per-frame movement never triggers a render, and **one clock rules everything: the audio clock.**

- `Timeline` says when every row of the song reaches the bar (and how the tempo steps up each lap).
- Each frame the engine reads the clock and places every tile from it, so a tile's position is a pure function of time.
- The recording plays on that same clock (its playback rate steps up with each lap), so tiles and audio can't drift apart.
- A tap is graded only by `tap time − the time its tile was centred on the bar`.
- Pausing suspends the audio clock, which freezes tiles and music together. Resuming holds the song still on the engine's own clock while a four-beat count-in is ticked out on the beat grid, then lets it run from exactly where it stopped, with the recording re-scheduled to join at the right point.
- A lap that is cut short tells the audio where to stop (`end`); the recording fades out there and the next lap starts it again.

| File | Role |
| --- | --- |
| `src/game/timeline.ts` | The song clock: row arrival times, scroll position, lap speed-ups and the rest and count-in before each lap |
| `src/game/engine.ts` | Frame loop, beat layout (gaps included), tap/double/hold rules, judgments, chains, laps |
| `src/game/renderer.ts` | Owns the tile DOM nodes; positions are written straight to `transform` |
| `src/components/Board.tsx`, `InputLog.tsx` | The board takes every finger as its own pointer (a cancelled touch is not a release, and the browser is kept from starting gestures on it); `InputLog` is the `?input` readout |
| `src/game/input.ts`, `trace.ts` | `eventAge` says how long ago a touch or key really happened (taps are graded then); `trace` is the one-line-at-a-time feed of what the engine did with each tap that the `?input` readout listens to (nothing is built when it isn't open) |
| `src/game/effects.ts` | Canvas visuals: animated backdrop, the timing bar, hit bursts, ripples, popups, banners |
| `src/game/audio.ts` | Web Audio: plays a song's recording at each lap's speed. It also has a small synth (lead, drums, bass, chords) for a song that has notes instead of a recording, which the tests use |
| `src/game/storage.ts` | Per-song best score, chain and laps (the key carries a version, moved on to reset everyone's) |
| `src/songs/` | Note-notation parser and the arrangement builder (used by the synth path and the tests), and `songs.ts`, the numbers the screens show about a song |
| `src/songs/analysis/` | The in-browser analyser for added songs: spectral onsets, tempo and beat grid, tile placement (`analyze.ts` and friends), where a long song stops (`length.ts`), run in a worker (`analyzer.worker.ts`, `client.ts`) |
| `src/songs/` (added songs) | `decode.ts` reads a file's audio, `importer.ts` adds / re-charts / tunes / removes a song, `store.ts` keeps songs in IndexedDB, `bundle.ts` is the `.pianotiles` song file, `chart.ts` and `library.ts` turn stored charts into playable songs |
| `src/cloud/` | The shared database: `catalog.ts` reads and writes the published songs (audio cut into pieces); `reconcile.ts` plans (`planCatalog`, pure) and runs (`syncCatalog`, `ensureAudio`) bringing this device level with them; `publish.ts` publishes and takes down; `board.ts` the leaderboards, nicknames and admin check; `names.ts` the nickname rules; `firebase.ts` loads the SDK on demand and signs in; `errors.ts` words for what can go wrong; `config.ts` the public Firebase config; `testing.ts` fake backends for the tests |
| `firestore.rules` | Who may read and write what in the database (pasted into the console; see [Setting it up](#setting-it-up-once-in-the-firebase-console)) |
| `src/hooks/useCloud.ts` | Who is signed in (guest or Google), the nickname, whether they are the admin, and score submission |
| `src/hooks/useCatalog.ts` | Keeps the published songs level with this device (when the page opens, the connection returns, or you come back) and fetches a song's audio when it is first played |
| `src/components/` | The screens and overlays: song list (`SongSelect`, `AccountPanel`, `ImportPanel`, `JobStatus`), the separate `TuneScreen` (with Publish), the leaderboard (`Leaderboard`, `NameForm`, `RunStanding`), the HUD, pause and game over |
| `src/hooks/useGame.ts` | Bridges the engine to React; state updates only on start, each score, each lap, pause and game over |
| `src/index.css` | Tile looks and animations, switched by `data-kind` / `data-state` attributes |
| `src/config.ts` | Tunables: timing windows, points, chain steps, lap speed step |

Tile positions are percentages of board height (`yPos`, 0–100), so the game looks identical at any screen size. Visual effects respect `prefers-reduced-motion`.

## Deployment

Every push to `main` runs `.github/workflows/deploy.yml`, which runs the tests, builds the site and publishes it to GitHub Pages.
