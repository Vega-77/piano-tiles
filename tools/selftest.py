#!/usr/bin/env python3
"""Checks the analyser against songs made here, where the true tempo and start are known.

Run with `npm run test:analyzer`. It needs `npm run setup:songs` first, and is not part of CI.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import soundfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import analyze  # noqa: E402

RATE = 44100
failures: list[str] = []


def check(condition: bool, message: str) -> None:
    print(('  ok    ' if condition else '  FAIL  ') + message)
    if not condition:
        failures.append(message)


def synth(bpm: float, offset: float, seconds: float, seed: int = 1, jitter: float = 0.0, warp: float = 0.0) -> np.ndarray:
    """A little song: kick, snare, hats, a bass line and a lead. Beat 1 falls at `offset` seconds.

    `jitter` is how far (seconds, standard deviation) each player is off the beat, like a human band;
    `warp` speeds the song up: a beat that would fall at t falls at t - warp * t^2 / seconds.
    """
    rng = np.random.default_rng(seed)
    out = np.zeros(int(seconds * RATE))
    beat = 60.0 / bpm

    def add(at: float, sound: np.ndarray) -> None:
        at = at - warp * at * at / seconds + rng.normal(0.0, jitter)
        start = int(round(at * RATE))
        if 0 <= start < len(out):
            sound = sound.copy()
            fade = min(len(sound), int(0.03 * RATE))  # no click where a sound is cut off
            sound[-fade:] *= np.linspace(1.0, 0.0, fade)
            end = min(len(out), start + len(sound))
            out[start:end] += sound[: end - start]

    def envelope(n: int, decay: float) -> np.ndarray:
        return np.exp(-np.arange(n) / RATE / decay)

    t = np.arange(int(0.4 * RATE)) / RATE
    kick = np.sin(2 * np.pi * (45 * t + 90 * (1 - np.exp(-t * 30)) / 30)) * envelope(len(t), 0.12)
    snare = (rng.standard_normal(int(0.25 * RATE)) * 0.8) * envelope(int(0.25 * RATE), 0.06)
    hat = np.diff(rng.standard_normal(int(0.08 * RATE) + 1)) * envelope(int(0.08 * RATE), 0.015)
    pluck_t = np.arange(int(0.5 * RATE)) / RATE

    def pluck(freq: float, decay: float) -> np.ndarray:
        return (np.sin(2 * np.pi * freq * pluck_t) + 0.4 * np.sin(4 * np.pi * freq * pluck_t)) * envelope(len(pluck_t), decay)

    scale = [261.63, 293.66, 329.63, 392.0, 440.0]
    step = 0
    while True:
        at = offset + step * beat / 2  # eighth notes
        if at >= seconds:
            break
        on_beat = step % 2 == 0
        bar_pos = (step // 2) % 4
        if on_beat and bar_pos in (0, 2):
            add(at, 0.9 * kick)
        if on_beat and bar_pos in (1, 3):
            add(at, 0.6 * snare)
        add(at, (0.25 if on_beat else 0.14) * hat)
        if on_beat:
            add(at, 0.35 * pluck(65.41 * (1 if bar_pos < 2 else 1.5), 0.25))
        if step % 8 in (0, 3, 6):
            add(at, 0.25 * pluck(scale[int(rng.integers(len(scale)))], 0.18))
        step += 1
    out += 0.01 * rng.standard_normal(len(out))
    return (out / max(1.0, np.abs(out).max() / 0.9)).astype(np.float32)


def write_wav(path: Path, samples: np.ndarray) -> None:
    soundfile.write(str(path), samples, RATE)


def grid_error(chart: dict, bpm: float, offset: float) -> tuple[float, float]:
    """(relative tempo error of the row grid against the nearest multiple, phase error in ms)."""
    rate = chart['bpm'] * chart['rowsPerBeat'] / 60.0
    true = bpm / 60.0
    multiple = max(1, round(rate / true)) if rate >= true else 1 / round(true / rate)
    tempo_error = abs(rate / (true * multiple) - 1)
    row = 1.0 / rate
    diff = (chart['offset'] - offset) % row
    phase_error = min(diff, row - diff) * 1000
    return tempo_error, phase_error


def run_import(folder: Path, source: Path, *extra: str) -> dict:
    out = folder / 'songs'
    result = subprocess.run(
        [sys.executable, str(Path(analyze.__file__)), 'import', str(source), '--out', str(out), *extra],
        capture_output=True, text=True,
    )
    events = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
    last = events[-1] if events else {'event': 'error', 'message': result.stderr}
    if last['event'] != 'done':
        raise SystemExit(f"import failed: {last.get('message')}")
    return last['chart']


def main() -> int:
    with tempfile.TemporaryDirectory() as temp:
        folder = Path(temp)

        for bpm, offset, seconds in [(120, 0.37, 45), (97, 0.12, 75), (140, 0.0, 40), (85, 0.61, 50)]:
            print(f'\n{bpm} BPM, first beat at {offset}s, {seconds}s long')
            wav = folder / f'song-{bpm}.wav'
            write_wav(wav, synth(bpm, offset, seconds, seed=bpm))
            chart = run_import(folder, wav, '--id', f's{bpm}')
            tempo_error, phase_error = grid_error(chart, bpm, offset)
            row_ms = 1000 / (chart['bpm'] * chart['rowsPerBeat'] / 60)
            print(f"  found {chart['bpm']} BPM x {chart['rowsPerBeat']} rows, offset {chart['offset']}s, "
                  f"confidence {chart['analysis']['confidence']}, drift {chart['analysis']['drift']}s")
            check(tempo_error < 0.002, f'tempo within 0.2% ({tempo_error * 100:.3f}%)')
            check(phase_error < 8, f'first row within 8ms of a true beat ({phase_error:.1f}ms of a {row_ms:.0f}ms row)')
            check(chart['analysis']['confidence'] > 0.6, 'confident')
            check(chart['analysis']['drift'] < 0.03, 'no drift')
            check(not chart['analysis']['warnings'], 'no warnings')
            check(20 <= chart['analysis']['tiles'] <= chart['analysis']['rows'], 'has a sensible number of tiles')
            check(analyze.MIN_ROWS_PER_SECOND <= chart['bpm'] * chart['rowsPerBeat'] / 60 <= analyze.MAX_ROWS_PER_SECOND,
                  'rows fall at a playable rate')

        print('\na human band: every player 10ms off the beat, on average')
        wav = folder / 'human.wav'
        write_wav(wav, synth(104, 0.29, 60, seed=7, jitter=0.010))
        chart = run_import(folder, wav, '--id', 'human')
        tempo_error, phase_error = grid_error(chart, 104, 0.29)
        print(f"  found {chart['bpm']} BPM, offset {chart['offset']}s, confidence {chart['analysis']['confidence']}")
        check(tempo_error < 0.003, f'tempo within 0.3% ({tempo_error * 100:.3f}%)')
        check(phase_error < 15, f'first row within 15ms of a true beat ({phase_error:.1f}ms)')
        check(chart['analysis']['confidence'] > 0.4 and not chart['analysis']['warnings'], 'still confident')

        print('\na tempo that speeds up (1% over the song)')
        wav = folder / 'warped.wav'
        write_wav(wav, synth(100, 0.2, 90, seed=3, warp=0.005))
        chart = run_import(folder, wav, '--id', 'warped')
        print(f"  found {chart['bpm']} BPM, drift {chart['analysis']['drift']}s")
        check(any('drift' in w for w in chart['analysis']['warnings']), f"warns about it ({chart['analysis']['warnings']})")

        print('\na tempo given by hand, a few BPM off')
        chart = run_import(folder, folder / 'song-120.wav', '--id', 'hand', '--bpm', '118')
        tempo_error, phase_error = grid_error(chart, 120, 0.37)
        check(chart['analysis']['manualBpm'] is True, 'noted as manual')
        check(tempo_error < 0.002 and phase_error < 20, f'refined to the true grid ({chart["bpm"]} BPM, {phase_error:.1f}ms)')

        print('\ndensity settings')
        counts = {level: run_import(folder, folder / 'song-97.wav', '--id', f'd-{level}', '--density', level)['analysis']['tiles']
                  for level in ('easy', 'normal', 'hard')}
        check(counts['easy'] < counts['normal'] < counts['hard'], f'more tiles as it gets harder {counts}')

        print('\ntiles land on the drums, not between them')
        chart = run_import(folder, folder / 'song-120.wav', '--id', 'onbeat', '--density', 'normal')
        beat = 60.0 / 120
        row = beat / chart['rowsPerBeat']
        position, on_beat, total = 0, 0, 0
        for token in chart['chart'].split():
            if token.startswith('.'):
                position += int(token[1:]) if len(token) > 1 else 1
                continue
            total += 1
            beats = (chart['offset'] + position * row - 0.37) / beat  # how far into the song's beats this tile is
            on_beat += abs(beats - round(beats)) < 0.1
            position += int(token[2:]) if token.startswith('x~') else 1
        check(on_beat / total > 0.7, f'{on_beat}/{total} tiles are on a true beat, not between them')

        print('\na video file (mp4)')
        mp4 = folder / 'clip.mp4'
        analyze.run_ffmpeg([
            '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10:d=40', '-i', str(folder / 'song-97.wav'),
            '-t', '40', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', str(mp4),
        ])
        chart = run_import(folder, mp4, '--id', 'video', '--title', 'From A Video')
        tempo_error, phase_error = grid_error(chart, 97, 0.12)
        check(chart['title'] == 'From A Video' and chart['id'] == 'video', 'keeps the title and id')
        check(tempo_error < 0.003 and phase_error < 25, f'finds the beat in the video ({tempo_error * 100:.3f}%, {phase_error:.1f}ms)')
        check((folder / 'songs' / 'video' / chart['audio']).stat().st_size > 10_000, 'wrote an mp3')
        check(abs(chart['duration'] - 40) < 0.2, f"duration is right ({chart['duration']}s)")
        manifest = json.loads((folder / 'songs' / 'index.json').read_text())
        check('video' in manifest['songs'] and manifest['songs'] == sorted(manifest['songs']), 'is in the song list')

        print('\nfiles that cannot be charted')
        silence = folder / 'silence.wav'
        write_wav(silence, np.zeros(RATE * 20, dtype=np.float32))
        result = subprocess.run([sys.executable, str(Path(analyze.__file__)), 'import', str(silence), '--out', str(folder / 'songs')],
                                capture_output=True, text=True)
        last = json.loads(result.stdout.strip().splitlines()[-1])
        check(result.returncode != 0 and last['event'] == 'error', f"silence is refused politely ({last.get('message')})")
        junk = folder / 'junk.mp4'
        junk.write_bytes(b'not a video' * 100)
        result = subprocess.run([sys.executable, str(Path(analyze.__file__)), 'import', str(junk), '--out', str(folder / 'songs')],
                                capture_output=True, text=True)
        last = json.loads(result.stdout.strip().splitlines()[-1])
        check(result.returncode != 0 and last['event'] == 'error', f"junk is refused politely ({last.get('message')})")

        print('\nre-charting and removing')
        result = subprocess.run([sys.executable, str(Path(analyze.__file__)), 'rechart', 's97', '--out', str(folder / 'songs'),
                                 '--bpm', '97', '--title', 'Renamed'], capture_output=True, text=True)
        last = json.loads(result.stdout.strip().splitlines()[-1])
        check(last['event'] == 'done' and last['chart']['title'] == 'Renamed' and last['chart']['analysis']['manualBpm'],
              'rechart keeps the audio and takes the new settings')
        result = subprocess.run([sys.executable, str(Path(analyze.__file__)), 'tune', 's97', '--out', str(folder / 'songs'),
                                 '--nudge-ms', '35', '--title', '  Tuned  '], capture_output=True, text=True)
        last = json.loads(result.stdout.strip().splitlines()[-1])
        check(last['event'] == 'done' and last['chart']['nudge'] == 0.035 and last['chart']['title'] == 'Tuned',
              'tune sets a nudge and cleans up the title')
        result = subprocess.run([sys.executable, str(Path(analyze.__file__)), 'rechart', 's97', '--out', str(folder / 'songs')],
                                capture_output=True, text=True)
        last = json.loads(result.stdout.strip().splitlines()[-1])
        check(last['event'] == 'done' and last['chart'].get('nudge') == 0.035, 'a nudge survives re-charting')
        result = subprocess.run([sys.executable, str(Path(analyze.__file__)), 'tune', 's97', '--out', str(folder / 'songs'),
                                 '--nudge-ms', '9000'], capture_output=True, text=True)
        check(result.returncode != 0 and 'at most' in result.stdout, 'a silly nudge is refused')
        subprocess.run([sys.executable, str(Path(analyze.__file__)), 'remove', 's97', '--out', str(folder / 'songs')],
                       capture_output=True, text=True)
        check(not (folder / 'songs' / 's97').exists()
              and 's97' not in json.loads((folder / 'songs' / 'index.json').read_text())['songs'], 'remove deletes the song and its listing')

    print()
    if failures:
        print(f'{len(failures)} check(s) failed')
        return 1
    print('all checks passed')
    return 0


if __name__ == '__main__':
    sys.exit(main())
