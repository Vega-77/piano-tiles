import { describe, expect, it } from 'vitest';
import type { Groove, MusicEvent } from '../types';
import { buildTrack, chordMidi } from './arrangement';
import { midiToFrequency, noteToFrequency, parseBeats } from './notation';

describe('chordMidi', () => {
  it('builds major, minor, seventh and diminished chords on a root octave', () => {
    expect(chordMidi('C', 3)).toEqual([48, 52, 55]);
    expect(chordMidi('Am', 3)).toEqual([57, 60, 64]);
    expect(chordMidi('G7', 3)).toEqual([55, 59, 62, 65]);
    expect(chordMidi('Bdim', 3)).toEqual([59, 62, 65]);
    expect(chordMidi('Em7', 3)).toEqual([52, 55, 59, 62]);
  });

  it('understands sharps and flats on the root', () => {
    expect(chordMidi('F#', 3)[0]).toBe(chordMidi('F', 3)[0] + 1);
    expect(chordMidi('Bb', 3)[0]).toBe(chordMidi('B', 3)[0] - 1);
  });

  it('rejects things that are not chords', () => {
    expect(() => chordMidi('H', 3)).toThrow();
    expect(() => chordMidi('Cmaj9', 3)).toThrow();
  });
});

const byKind = (events: readonly MusicEvent[] | undefined, kind: MusicEvent['kind']) =>
  (events ?? []).filter((e) => e.kind === kind);

describe('buildTrack', () => {
  it('puts the melody where its notes fall, with rests as silence', () => {
    const track = buildTrack(parseBeats('C4 . D4~3 E4+G4'));
    expect(track).toHaveLength(6);
    expect(track[0]).toEqual([{ kind: 'melody', freq: noteToFrequency('C4') }]);
    expect(track[1]).toEqual([]);
    expect(track[2]).toEqual([{ kind: 'melody', freq: noteToFrequency('D4'), rows: 2.6 }]);
    expect(track[3]).toEqual([]);
    expect(byKind(track[5], 'melody')).toHaveLength(2);
  });

  it('rings both notes of a double hold for most of its length', () => {
    const track = buildTrack(parseBeats('C4+E4~3 . D4'));
    expect(track).toHaveLength(5);
    expect(track[0]).toEqual([
      { kind: 'melody', freq: noteToFrequency('C4'), rows: 2.6 },
      { kind: 'melody', freq: noteToFrequency('E4'), rows: 2.6 },
    ]);
    expect(track[1]).toEqual([]);
    expect(byKind(track[4], 'melody')).toHaveLength(1);
  });

  describe('with an arrangement', () => {
    const groove: Groove = { kick: 'x...', snare: '..o.', hat: 'xoxo', bass: '1.5.', chord: '.x..', pad: true };
    const track = buildTrack(parseBeats('C4 D4 E4 F4 | G4 A4 B4 C5'), {
      rowsPerBar: 4,
      chords: ['C', 'F/G'],
      groove,
    });

    it('lays the drums out row by row from the pattern', () => {
      expect(byKind(track[0], 'kick')).toHaveLength(1);
      expect(byKind(track[1], 'kick')).toHaveLength(0);
      expect(byKind(track[4], 'kick')).toHaveLength(1); // and again in the second bar
      expect(byKind(track[2], 'snare')).toEqual([{ kind: 'snare', soft: true }]);
      expect(byKind(track[0], 'hat')).toEqual([{ kind: 'hat', soft: false }]);
      expect(byKind(track[1], 'hat')).toEqual([{ kind: 'hat', soft: true }]);
    });

    it('plays the bass on the chord root and fifth, ringing until the next note', () => {
      const [root] = byKind(track[0], 'bass');
      expect(root).toEqual({ kind: 'bass', freq: midiToFrequency(chordMidi('C', 2)[0]), rows: 2 });
      const [fifth] = byKind(track[2], 'bass');
      expect(fifth).toEqual({ kind: 'bass', freq: midiToFrequency(chordMidi('C', 2)[0] + 7), rows: 2 });
    });

    it('follows the chord changes, including a change halfway through a bar', () => {
      // Second bar is "F/G": F for the first half, G for the second.
      const [bassOnF] = byKind(track[4], 'bass');
      expect(bassOnF).toMatchObject({ freq: midiToFrequency(chordMidi('F', 2)[0]) });
      const [bassOnG] = byKind(track[6], 'bass');
      expect(bassOnG).toMatchObject({ freq: midiToFrequency(chordMidi('G', 2)[0] + 7) });
    });

    it('plays chord stabs where the pattern says and a pad under each chord', () => {
      const [stab] = byKind(track[1], 'chord');
      expect(stab).toEqual({ kind: 'chord', freqs: chordMidi('C', 3).map(midiToFrequency), rows: 1 });
      const pads = track.flatMap((events) => byKind(events, 'chord')).filter((e) => e.kind === 'chord' && e.pad);
      // One pad for bar one, and one for each half of bar two.
      expect(pads).toHaveLength(3);
      expect(byKind(track[0], 'chord').some((e) => e.kind === 'chord' && e.pad && e.rows === 4)).toBe(true);
      expect(byKind(track[4], 'chord').some((e) => e.kind === 'chord' && e.pad && e.rows === 2)).toBe(true);
      expect(byKind(track[6], 'chord').some((e) => e.kind === 'chord' && e.pad && e.rows === 2)).toBe(true);
    });
  });
});
