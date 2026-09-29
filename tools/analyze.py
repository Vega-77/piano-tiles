#!/usr/bin/env python3
"""Turns a song (any audio or video file) into a Piano Tiles chart.

    analyze.py import <file>  --out public/songs [--id ID] [--title T] [--artist A] [--bpm N] [--density easy|normal|hard]
    analyze.py rechart <id>   --out public/songs [--title T] [--bpm N] [--density ...] [--auto]
    analyze.py tune <id>      --out public/songs [--title T] [--artist A] [--nudge-ms N]
    analyze.py remove <id>    --out public/songs

`import` converts the audio to a small MP3, finds the beat grid (tempo and where the first row
falls), and picks which rows get tiles from where the music hits hardest. `rechart` redoes the
analysis on the MP3 already in the songs folder, with a tempo or density given by hand. `tune`
changes a song's name, or nudges its audio against the tiles, without analysing anything.

Progress goes to stdout as JSON lines: {"event": "stage", ...}, then {"event": "done", "chart": {...}}
or {"event": "error", "message": ...}.

How the beat grid works: the game lays tiles on a grid of equally spaced "rows". The analyser looks
for the row rate (rows per second) and phase (the moment of row 0) at which the music's onsets land
on the grid most often, searching finely enough that a whole song stays in step. Because only the
row grid matters, the usual halving/doubling mistakes of tempo detection don't matter much: 60 BPM
with four rows a beat is the same grid as 120 BPM with two.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import warnings
from dataclasses import dataclass
from pathlib import Path

import numpy as np

# ---- analysis settings ------------------------------------------------------------------------
SR = 22050  # analysis sample rate
HOP = 128  # samples per feature frame: 5.8 ms
N_FFT = 512
FPS = SR / HOP

# The onset envelope peaks a little before the sound really starts (the analysis window sees the
# attack coming). This is how much later than an envelope peak the true onset is, in seconds,
# measured on songs with known beats; tools/selftest.py fails if it is off.
ENV_LAG = 0.0033

TARGET_ROWS_PER_SECOND = 4.0  # what the row grid is nudged towards: fast enough to be musical, slow enough to tap
MIN_ROWS_PER_SECOND = 2.4
MAX_ROWS_PER_SECOND = 6.2
MAX_MINUTES = 15
MIN_TILES = 20
DRIFT_WARNING = 0.08  # seconds the beat may slide against the grid before we say so (a PERFECT is +-0.075s)
MAX_NUDGE_MS = 500  # keep in step with MAX_NUDGE in src/songs/chart.ts

DENSITY = {
    # gap: fewest rows between two tiles; fraction: share of rows that get a tile;
    # doubles / holds: at most this share of the tiles is a double / hold.
    'easy': {'gap': 2, 'fraction': 0.28, 'doubles': 0.0, 'holds': 0.12},
    'normal': {'gap': 2, 'fraction': 0.40, 'doubles': 0.03, 'holds': 0.12},
    'hard': {'gap': 1, 'fraction': 0.52, 'doubles': 0.06, 'holds': 0.10},
}
MAX_TAP_RATE = 4.5  # taps per second no chart is allowed to ask for
HOLD_ROWS = (2, 4)


class AnalysisError(Exception):
    """Something the user can understand and fix (a bad file, no beat found)."""


def emit(event: str, **fields) -> None:
    print(json.dumps({'event': event, **fields}), flush=True)


def stage(name: str, message: str) -> None:
    emit('stage', stage=name, message=message)


# ---- ffmpeg -----------------------------------------------------------------------------------
def ffmpeg_exe() -> str:
    override = os.environ.get('PIANO_TILES_FFMPEG')
    if override:
        return override
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        found = shutil.which('ffmpeg')
        if found:
            return found
        raise AnalysisError('ffmpeg was not found. Run `npm run setup:songs`.')


def run_ffmpeg(args: list[str]) -> None:
    command = [ffmpeg_exe(), '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', *args]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        message = result.stderr.strip().splitlines()
        text = message[-1] if message else 'ffmpeg failed'
        if 'matches no streams' in result.stderr or 'does not contain any stream' in result.stderr:
            text = 'That file has no audio track.'
        elif 'Invalid data found' in result.stderr or 'could not find codec' in result.stderr:
            text = "That file isn't audio or video ffmpeg can read."
        raise AnalysisError(text)


def to_mp3(source: Path, destination: Path) -> None:
    run_ffmpeg([
        '-i', str(source), '-vn', '-map', '0:a:0', '-map_metadata', '-1',
        '-ac', '2', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '128k', str(destination),
    ])


def decode_mono(source: Path) -> np.ndarray:
    import soundfile

    with tempfile.TemporaryDirectory() as folder:
        wav = Path(folder) / 'decoded.wav'
        run_ffmpeg(['-i', str(source), '-vn', '-map', '0:a:0', '-ac', '1', '-ar', str(SR), '-c:a', 'pcm_f32le', str(wav)])
        samples, _ = soundfile.read(str(wav), dtype='float32')
    return np.asarray(samples, dtype=np.float32)


# ---- features ---------------------------------------------------------------------------------
@dataclass
class Features:
    env: np.ndarray  # onset strength per frame, local average removed
    low: np.ndarray  # the same, per frequency band
    mid: np.ndarray
    high: np.ndarray
    rms: np.ndarray  # loudness per frame
    duration: float

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(path, env=self.env, low=self.low, mid=self.mid, high=self.high, rms=self.rms,
                            duration=self.duration, version=FEATURE_VERSION)

    @staticmethod
    def load(path: Path) -> 'Features | None':
        try:
            data = np.load(path)
            if int(data['version']) != FEATURE_VERSION:
                return None
            return Features(data['env'], data['low'], data['mid'], data['high'], data['rms'], float(data['duration']))
        except (OSError, KeyError, ValueError):
            return None


FEATURE_VERSION = 1


def moving_average(values: np.ndarray, size: int) -> np.ndarray:
    from scipy.ndimage import uniform_filter1d

    return uniform_filter1d(values, size=max(1, size), mode='nearest')


def compute_features(samples: np.ndarray) -> Features:
    import librosa

    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        power = np.abs(librosa.stft(samples, n_fft=N_FFT, hop_length=HOP, center=True)) ** 2
        mel = librosa.feature.melspectrogram(S=power, sr=SR, n_mels=26, fmin=40, fmax=9000)
        freqs = librosa.mel_frequencies(n_mels=26, fmin=40, fmax=9000)
    db = librosa.power_to_db(mel, ref=np.max, top_db=80.0)
    flux = np.maximum(0.0, np.diff(db, axis=1, prepend=db[:, :1]))

    def band(mask: np.ndarray) -> np.ndarray:
        return flux[mask].mean(axis=0)

    def detrend(values: np.ndarray) -> np.ndarray:
        return np.maximum(0.0, values - moving_average(values, int(0.3 * FPS)))

    rms = np.sqrt(power.sum(axis=0))
    return Features(
        env=detrend(flux.mean(axis=0)),
        low=detrend(band(freqs < 250)),
        mid=detrend(band((freqs >= 250) & (freqs <= 2500))),
        high=detrend(band(freqs > 2500)),
        rms=moving_average(rms, int(0.05 * FPS)),
        duration=len(samples) / SR,
    )


# ---- the beat grid ----------------------------------------------------------------------------
@dataclass
class Grid:
    rate: float  # rows per second
    phase: float  # audio time of row 0, in seconds (under one row)
    score: float  # how strongly the music lands on the grid
    contrast: float

    @property
    def row(self) -> float:
        return 1.0 / self.rate


def pick_rows_per_beat(rate: float) -> tuple[int, float]:
    """Rows per beat (1, 2 or 4) and the BPM that gives, so the BPM reads like a real tempo."""
    options = [(rpb, 60.0 * rate / rpb) for rpb in (1, 2, 4)]
    sensible = [o for o in options if 78 <= o[1] < 175]
    pool = sensible or options
    return min(pool, key=lambda o: abs(math.log(o[1] / 120.0)))


def rows_per_beat_for_bpm(bpm: float) -> int:
    """The rows per beat that puts a hand-entered tempo nearest TARGET_ROWS_PER_SECOND."""
    return min((1, 2, 4), key=lambda rpb: abs(math.log(bpm * rpb / 60.0 / TARGET_ROWS_PER_SECOND)))


def sample_env(env: np.ndarray, times: np.ndarray) -> np.ndarray:
    """The envelope at arbitrary audio times (true onset time = frame time + ENV_LAG), linearly interpolated."""
    position = np.clip((times - ENV_LAG) * FPS, 0, len(env) - 1.001)
    lower = position.astype(np.int64)
    fraction = position - lower
    return env[lower] * (1 - fraction) + env[lower + 1] * fraction


def grid_scores(env: np.ndarray, rate: float, phases: np.ndarray) -> np.ndarray:
    """Mean envelope on the grid of period 1/rate, for each phase."""
    end = len(env) / FPS - 0.1
    count = max(8, int((end - float(phases.max())) * rate))
    steps = np.arange(count) / rate
    return sample_env(env, phases[:, None] + steps[None, :]).mean(axis=1)


def search_grid(env: np.ndarray, centre: float, width: float) -> Grid:
    """Best (rate, phase) within +-width (a fraction) of `centre` rows per second."""
    coarse = 1.6e-4
    best_rate, best_phase, best_score = centre, 0.0, -1.0
    for factor in np.arange(-width, width + coarse / 2, coarse):
        rate = centre * (1 + factor)
        phases = np.arange(0.0, 1.0 / rate, 0.006)
        scores = grid_scores(env, rate, phases)
        j = int(scores.argmax())
        if scores[j] > best_score:
            best_rate, best_phase, best_score = rate, float(phases[j]), float(scores[j])

    fine = coarse / 8
    for factor in np.arange(-3 * coarse, 3 * coarse + fine / 2, fine):
        rate = best_rate * (1 + factor)
        phases = best_phase + np.arange(-0.012, 0.012 + 1e-9, 0.0015)
        scores = grid_scores(env, rate, phases)
        j = int(scores.argmax())
        if scores[j] > best_score:
            best_rate, best_phase, best_score = rate, float(phases[j]), float(scores[j])

    row = 1.0 / best_rate
    baseline = float(env.mean()) or 1e-9
    return Grid(best_rate, best_phase % row, best_score, best_score / baseline)


def tempo_candidates(env: np.ndarray) -> list[float]:
    """Rough tempos (BPM) from librosa's tempogram and beat tracker, from several starting guesses."""
    import librosa

    found: list[float] = []
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        for start in (80.0, 120.0, 160.0):
            tempo = librosa.feature.tempo(onset_envelope=env, sr=SR, hop_length=HOP, start_bpm=start, aggregate=np.mean)
            found.append(float(np.atleast_1d(tempo)[0]))
        tempo, beats = librosa.beat.beat_track(onset_envelope=env, sr=SR, hop_length=HOP, units='time')
        found.append(float(np.atleast_1d(tempo)[0]))
        if len(beats) > 8:
            found.append(60.0 / float(np.median(np.diff(beats))))
    return [t for t in found if 30 <= t <= 320]


def prior(rate: float) -> float:
    """Prefer grids near TARGET_ROWS_PER_SECOND: a log-normal bump, so 2x or 0.5x is heavily discounted."""
    return math.exp(-0.5 * (math.log(rate / TARGET_ROWS_PER_SECOND) / 0.35) ** 2)


def find_grid(features: Features, bpm: float | None) -> tuple[Grid, int, float]:
    """The row grid, rows per beat and BPM: from a tempo given by hand, or found from the music."""
    env = features.env
    if bpm is not None:
        rpb = rows_per_beat_for_bpm(bpm)
        grid = search_grid(env, bpm * rpb / 60.0, 0.02)
        return grid, rpb, 60.0 * grid.rate / rpb

    centres: list[float] = []
    for tempo in tempo_candidates(env):
        for multiple in (0.5, 1, 2, 4):
            rate = tempo / 60.0 * multiple
            if MIN_ROWS_PER_SECOND <= rate <= MAX_ROWS_PER_SECOND and all(abs(rate / c - 1) > 0.015 for c in centres):
                centres.append(rate)
    if not centres:
        raise AnalysisError("Couldn't find a steady beat in that audio. Try giving the tempo by hand.")

    best: Grid | None = None
    for centre in centres:
        grid = search_grid(env, centre, 0.03)
        if best is None or grid.contrast * prior(grid.rate) > best.contrast * prior(best.rate):
            best = grid
    assert best is not None
    rpb, tempo = pick_rows_per_beat(best.rate)
    return best, rpb, tempo


def grid_quality(features: Features, grid: Grid) -> tuple[float, float]:
    """(confidence 0-1, drift in seconds): how many strong onsets sit on the grid, and how far it slides over the song."""
    env = features.env
    ahead = np.ones(len(env), dtype=bool)
    for step in range(1, 5):  # a peak beats everything within four frames either side
        ahead &= (env >= np.roll(env, step)) & (env >= np.roll(env, -step))
    peaks = np.flatnonzero(ahead & (env > 0))
    if len(peaks) < 12:
        return 0.0, 0.0
    heights = env[peaks]
    keep = heights >= 0.2 * float(np.percentile(heights, 95))  # the flicker between hits doesn't count
    peaks, heights = peaks[keep], heights[keep]
    if len(peaks) < 12:
        return 0.0, 0.0
    times = peaks / FPS + ENV_LAG
    error = ((times - grid.phase) / grid.row + 0.5) % 1.0 - 0.5  # in rows, -0.5..0.5
    # The share of the hitting (louder hits count for more) that lands within 0.2 of a row of the grid.
    # Hits scattered at random would put 40% of it there, so that is zero confidence.
    share = float(heights[np.abs(error) <= 0.2].sum() / heights.sum())
    confidence = float(np.clip((share - 0.4) / 0.5, 0.0, 1.0))
    return confidence, grid_drift(times, heights, grid, features.duration)


def grid_drift(times: np.ndarray, heights: np.ndarray, grid: Grid, duration: float) -> float:
    """How far (seconds) the beat slides against the grid between the first and last part of the song.

    Each stretch of the song gets its own beat phase: the average of the hits' positions within a
    row, taken round a circle because a row's end is also its start. The phases are then followed
    from stretch to stretch (unwrapped), so a slide of more than a row is still seen as one.
    """
    stretches = int(min(8, max(2, duration // 12)))
    edges = np.linspace(0.0, duration, stretches + 1)
    angles: list[float] = []
    for low, high in zip(edges[:-1], edges[1:]):
        inside = (times >= low) & (times < high)
        if inside.sum() < 6:
            continue
        turn = 2 * np.pi * ((times[inside] - grid.phase) / grid.row)
        vector = np.sum(heights[inside] * np.exp(1j * turn))
        if abs(vector) < 0.3 * heights[inside].sum():
            continue  # no clear beat here (a quiet break, say)
        angles.append(float(np.angle(vector)))
    if len(angles) < 2:
        return 0.0
    followed = np.unwrap(angles)
    return float((followed.max() - followed.min()) / (2 * np.pi) * grid.row)


# ---- the chart --------------------------------------------------------------------------------
def slot_strengths(features: Features, grid: Grid, rows: int) -> tuple[np.ndarray, np.ndarray]:
    """Onset strength at each row of the grid, and how many frequency bands agree there (0-3).

    Each envelope frame counts towards the nearest row, less so the further it is from it, so a
    row is only strong when there really is a hit close to it.
    """
    times = np.arange(len(features.env)) / FPS + ENV_LAG
    k = np.rint((times - grid.phase) / grid.row).astype(np.int64)
    distance = np.abs(times - grid.phase - k * grid.row) / (0.5 * grid.row)
    weight = 1.0 - 0.7 * np.minimum(distance, 1.0) ** 2
    inside = (k >= 0) & (k < rows)

    def slots(values: np.ndarray) -> np.ndarray:
        out = np.zeros(rows)
        np.maximum.at(out, k[inside], (values * weight)[inside])
        return out

    strength = slots(features.env)
    agree = np.zeros(rows)
    for band in (features.low, features.mid, features.high):
        s = slots(band)
        scale = float(np.percentile(s[s > 0], 90)) if np.any(s > 0) else 1.0
        agree += (s >= 0.5 * scale).astype(float)
    return strength, agree


def row_loudness(features: Features, grid: Grid, rows: int) -> np.ndarray:
    """Mean loudness within each row of the grid."""
    times = np.arange(len(features.rms)) / FPS + ENV_LAG
    k = np.floor((times - grid.phase) / grid.row + 0.5).astype(np.int64)
    inside = (k >= 0) & (k < rows)
    total = np.bincount(k[inside], weights=features.rms[inside], minlength=rows)[:rows]
    count = np.bincount(k[inside], minlength=rows)[:rows]
    return total / np.maximum(count, 1)


@dataclass
class Chart:
    tokens: dict[int, tuple[str, int]]  # first row -> (kind, rows): kind is 'tap', 'double' or 'hold'
    rows: int


def choose_tiles(features: Features, grid: Grid, rows: int, level: str) -> Chart:
    settings = DENSITY[level]
    strength, agree = slot_strengths(features, grid, rows)
    loudness = row_loudness(features, grid, rows)

    gap = max(settings['gap'], math.ceil(grid.rate / MAX_TAP_RATE - 1e-9))
    active = strength[strength > 0]
    if len(active) == 0:
        raise AnalysisError("Couldn't find any beats in that audio.")
    floor = 0.12 * float(np.percentile(active, 98))
    wanted = int(settings['fraction'] * rows)

    blocked = np.zeros(rows, dtype=bool)
    chosen: list[int] = []
    for k in np.argsort(-strength, kind='stable'):
        if len(chosen) >= wanted or strength[k] < floor:
            break
        if blocked[k]:
            continue
        chosen.append(int(k))
        blocked[max(0, k - gap + 1): k + gap] = True
    chosen.sort()
    if len(chosen) < MIN_TILES:
        raise AnalysisError("Couldn't find enough beats to make a chart from. Try giving the tempo by hand.")

    tokens = {k: ('tap', 1) for k in chosen}
    following = {k: (chosen[i + 1] if i + 1 < len(chosen) else rows) for i, k in enumerate(chosen)}

    # Holds: a hit followed by rows of sustained sound with no other hit in them.
    def sustain(k: int) -> tuple[int, float]:
        room = min(HOLD_ROWS[1], following[k] - k)
        peak = float(loudness[k]) or 1e-9
        best = (0, 0.0)
        for length in range(HOLD_ROWS[0], room + 1):
            inner = range(k + 1, k + length)
            level_ = min(loudness[j] for j in inner) / peak
            quiet = all(strength[j] < 0.5 * strength[k] for j in inner)
            if level_ >= 0.6 and quiet:
                best = (length, level_)
        return best

    holds = 0
    last_hold = -100
    hold_cap = int(settings['holds'] * len(chosen))
    ranked = sorted(((sustain(k), k) for k in chosen), key=lambda item: -item[0][1])
    for (length, _), k in ranked:
        if holds >= hold_cap:
            break
        if length >= HOLD_ROWS[0] and abs(k - last_hold) >= 8:
            tokens[k] = ('hold', length)
            holds += 1
            last_hold = k

    # Doubles: the hardest hits, where the low, middle and high of the sound all agree.
    double_cap = int(settings['doubles'] * len(chosen))
    if double_cap:
        strong = sorted((k for k in chosen if tokens[k][0] == 'tap' and agree[k] >= 2), key=lambda k: -strength[k])
        for k in strong[:double_cap]:
            neighbours = [j for j in range(k - 1, k + 2) if j != k and j in tokens]
            if not neighbours:
                tokens[k] = ('double', 1)
    return Chart(tokens, rows)


def format_chart(chart: Chart) -> str:
    """The chart in the game's notation: x tap, xx double, x~3 hold, . rest; eight rows to a line."""
    lines: list[str] = []
    line: list[str] = []
    row = 0
    while row < chart.rows:
        kind, length = chart.tokens.get(row, ('rest', 1))
        line.append({'tap': 'x', 'double': 'xx', 'hold': f'x~{length}', 'rest': '.'}[kind])
        row += length
        if row % 8 == 0 or row >= chart.rows:
            lines.append(' '.join(line))
            line = []
    if line:
        lines.append(' '.join(line))
    return '\n'.join(lines)


def describe(chart: Chart, grid: Grid, duration: float) -> dict:
    starts = sorted(chart.tokens)
    times = np.array([grid.phase + k * grid.row for k in starts])
    intervals = np.diff(times)
    peak = float(np.percentile(1.0 / intervals, 95)) if len(intervals) else 0.0
    average = len(starts) / duration
    return {'peak': peak, 'average': average}


def difficulty_of(peak: float, average: float, doubles: int) -> int:
    load = 0.5 * peak + 0.5 * average * 1.8
    value = 1 + (load - 1.6) / 0.55 + (0.3 if doubles else 0.0)
    return int(min(5, max(1, math.floor(value + 0.5))))


# ---- files ------------------------------------------------------------------------------------
def slugify(text: str) -> str:
    slug = re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-')[:48].strip('-')
    return slug or 'song'


def read_manifest(out: Path) -> list[str]:
    try:
        data = json.loads((out / 'index.json').read_text(encoding='utf-8'))
        return [s for s in data.get('songs', []) if isinstance(s, str)]
    except (OSError, ValueError):
        return []


def write_manifest(out: Path, ids: list[str]) -> None:
    out.mkdir(parents=True, exist_ok=True)
    (out / 'index.json').write_text(json.dumps({'songs': sorted(set(ids))}, indent=2) + '\n', encoding='utf-8')


def unique_id(wanted: str, taken: set[str]) -> str:
    if wanted not in taken:
        return wanted
    n = 2
    while f'{wanted}-{n}' in taken:
        n += 1
    return f'{wanted}-{n}'


def cache_dir() -> Path:
    return Path(__file__).resolve().parent / '.cache'


def audio_file(folder: Path) -> Path:
    found = sorted(folder.glob('audio-*.mp3'))
    if not found:
        raise AnalysisError('That song has no audio file.')
    return found[0]


def features_for(mp3: Path, digest: str) -> Features:
    cached = Features.load(cache_dir() / f'{digest}.npz')
    if cached is not None:
        return cached
    stage('decode', 'Reading the audio')
    samples = decode_mono(mp3)
    if len(samples) < SR * 5:
        raise AnalysisError('That audio is too short (under five seconds).')
    stage('features', 'Listening for hits')
    features = compute_features(samples)
    try:
        features.save(cache_dir() / f'{digest}.npz')
    except OSError:
        pass  # the cache is only a speed-up
    return features


def build_chart(
    features: Features,
    meta: dict,
    digest: str,
    audio_name: str,
    bpm: float | None,
    level: str,
) -> dict:
    stage('grid', 'Finding the beat')
    grid, rpb, tempo = find_grid(features, bpm)
    confidence, drift = grid_quality(features, grid)

    rows = max(1, math.ceil((features.duration - grid.phase) * grid.rate - 1e-9))
    stage('chart', 'Placing the tiles')
    chart = choose_tiles(features, grid, rows, level)
    numbers = describe(chart, grid, features.duration)
    doubles = sum(1 for kind, _ in chart.tokens.values() if kind == 'double')

    warnings_: list[str] = []
    if confidence < 0.35:
        warnings_.append("The beat is weak or uneven, so tiles may not line up with the music. Try setting the tempo by hand.")
    if drift > DRIFT_WARNING:
        warnings_.append('The tempo drifts over the song, so tiles may slide out of time. Setting the tempo by hand can help if it is only part of the song.')
    if grid.rate > MAX_ROWS_PER_SECOND - 0.3:
        warnings_.append('This song is very fast, so the tiles will fall quickly.')

    hue = int(digest[:4], 16) % 360
    return {
        'version': 1,
        'id': meta['id'],
        'title': meta['title'],
        'artist': meta['artist'],
        'audio': audio_name,
        'bpm': round(tempo, 3),
        'rowsPerBeat': rpb,
        'offset': round(grid.phase, 4),
        'duration': round(features.duration, 3),
        'difficulty': difficulty_of(numbers['peak'], numbers['average'], doubles),
        'hue': hue,
        'hue2': (hue + 55) % 360,
        'chart': format_chart(chart),
        'analysis': {
            'confidence': round(confidence, 3),
            'drift': round(drift, 4),
            'manualBpm': bpm is not None,
            'peakRate': round(numbers['peak'], 2),
            'tiles': len(chart.tokens),
            'rows': rows,
            'density': round(len(chart.tokens) / rows, 3),
            'level': level,
            'warnings': warnings_,
        },
    }


def write_song(out: Path, chart: dict) -> None:
    folder = out / chart['id']
    folder.mkdir(parents=True, exist_ok=True)
    (folder / 'chart.json').write_text(json.dumps(chart, indent=2) + '\n', encoding='utf-8')
    write_manifest(out, [*read_manifest(out), chart['id']])


# ---- commands ---------------------------------------------------------------------------------
def command_import(args: argparse.Namespace) -> None:
    source = Path(args.file)
    if not source.is_file():
        raise AnalysisError(f'{source} was not found.')
    out = Path(args.out)
    title = (args.title or source.stem.replace('_', ' ').strip()).strip() or 'Untitled'
    taken = set(read_manifest(out))
    song_id = args.id or unique_id(slugify(title), taken)
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', song_id):
        raise AnalysisError(f'"{song_id}" is not a valid song id.')

    with tempfile.TemporaryDirectory() as folder:
        staged = Path(folder) / 'audio.mp3'
        stage('convert', 'Converting the audio')
        to_mp3(source, staged)
        digest = hashlib.sha256(staged.read_bytes()).hexdigest()
        name = f'audio-{digest[:8]}.mp3'
        features = features_for(staged, digest)
        if features.duration > MAX_MINUTES * 60:
            raise AnalysisError(f'That song is over {MAX_MINUTES} minutes long.')

        meta = {'id': song_id, 'title': title, 'artist': args.artist or 'Imported'}
        chart = build_chart(features, meta, digest, name, args.bpm, args.density)

        stage('write', 'Saving the song')
        target = out / song_id
        target.mkdir(parents=True, exist_ok=True)
        for old in target.glob('audio-*.mp3'):
            old.unlink()
        shutil.copyfile(staged, target / name)
    write_song(out, chart)
    emit('done', chart=chart)


def command_rechart(args: argparse.Namespace) -> None:
    out = Path(args.out)
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', args.id):
        raise AnalysisError(f'"{args.id}" is not a valid song id.')
    folder = out / args.id
    try:
        chart = json.loads((folder / 'chart.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        raise AnalysisError(f'There is no song called "{args.id}".')
    mp3 = audio_file(folder)
    digest = hashlib.sha256(mp3.read_bytes()).hexdigest()
    features = features_for(mp3, digest)

    meta = {'id': chart['id'], 'title': args.title or chart['title'], 'artist': args.artist or chart.get('artist', 'Imported')}
    bpm = args.bpm
    if bpm is None and chart.get('analysis', {}).get('manualBpm') and not args.auto:
        bpm = float(chart['bpm'])
    level = args.density or chart.get('analysis', {}).get('level', 'normal')
    updated = build_chart(features, meta, digest, mp3.name, bpm, level)
    updated['hue'], updated['hue2'] = chart.get('hue', updated['hue']), chart.get('hue2', updated['hue2'])
    if 'nudge' in chart:
        updated['nudge'] = chart['nudge']
    stage('write', 'Saving the song')
    write_song(out, updated)
    emit('done', chart=updated)


def command_tune(args: argparse.Namespace) -> None:
    """Changes the details of a song by hand (no analysis): its name, or how far the audio is nudged."""
    out = Path(args.out)
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', args.id):
        raise AnalysisError(f'"{args.id}" is not a valid song id.')
    path = out / args.id / 'chart.json'
    try:
        chart = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        raise AnalysisError(f'There is no song called "{args.id}".')
    if args.title is not None:
        if not args.title.strip():
            raise AnalysisError('A song needs a name.')
        chart['title'] = args.title.strip()[:120]
    if args.artist is not None:
        chart['artist'] = args.artist.strip()[:120] or 'Imported'
    if args.nudge_ms is not None:
        if abs(args.nudge_ms) > MAX_NUDGE_MS:
            raise AnalysisError(f'The sync nudge can be at most {MAX_NUDGE_MS} ms either way.')
        if args.nudge_ms == 0:
            chart.pop('nudge', None)
        else:
            chart['nudge'] = round(args.nudge_ms / 1000.0, 4)
    write_song(out, chart)
    emit('done', chart=chart)


def command_remove(args: argparse.Namespace) -> None:
    out = Path(args.out)
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', args.id):
        raise AnalysisError(f'"{args.id}" is not a valid song id.')
    folder = out / args.id
    if folder.is_dir():
        shutil.rmtree(folder)
    write_manifest(out, [s for s in read_manifest(out) if s != args.id])
    emit('done', id=args.id)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest='command', required=True)

    def common(command: argparse.ArgumentParser) -> None:
        command.add_argument('--out', default='public/songs', help='the songs folder')
        command.add_argument('--title')
        command.add_argument('--artist')
        command.add_argument('--bpm', type=float, help='the tempo, if detection gets it wrong')
        command.add_argument('--density', choices=sorted(DENSITY))

    importing = commands.add_parser('import')
    importing.add_argument('file')
    importing.add_argument('--id')
    common(importing)
    importing.set_defaults(run=command_import, density_default='normal')

    rechart = commands.add_parser('rechart')
    rechart.add_argument('id')
    rechart.add_argument('--auto', action='store_true', help='forget a tempo given earlier and detect it again')
    common(rechart)
    rechart.set_defaults(run=command_rechart)

    tune = commands.add_parser('tune')
    tune.add_argument('id')
    tune.add_argument('--out', default='public/songs')
    tune.add_argument('--title')
    tune.add_argument('--artist')
    tune.add_argument('--nudge-ms', type=float, help='shift the audio against the tiles; positive if the tiles are early')
    tune.set_defaults(run=command_tune)

    remove = commands.add_parser('remove')
    remove.add_argument('id')
    remove.add_argument('--out', default='public/songs')
    remove.set_defaults(run=command_remove)

    args = parser.parse_args(argv)
    if args.command == 'import' and args.density is None:
        args.density = 'normal'
    if getattr(args, 'bpm', None) is not None and not 40 <= args.bpm <= 300:
        emit('error', message='The tempo must be between 40 and 300 BPM.')
        return 1
    try:
        args.run(args)
    except AnalysisError as error:
        emit('error', message=str(error))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
