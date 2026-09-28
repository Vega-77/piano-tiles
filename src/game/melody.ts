const SEMITONES: Record<string, number> = {
  C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11,
};

/** 'A4' -> 440 Hz */
function noteToFrequency(note: string): number {
  const match = /^([A-G]#?)(\d)$/.exec(note);
  if (!match) throw new Error(`Bad note: ${note}`);
  const midi = 12 * (Number(match[2]) + 1) + SEMITONES[match[1]];
  return 440 * 2 ** ((midi - 69) / 12);
}

// Ode to Joy. Each successful tap plays the next note, looping at the end.
const ODE_TO_JOY = [
  'E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 E4 D4 D4',
  'E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 D4 C4 C4',
  'D4 D4 E4 C4 D4 E4 F4 E4 C4 D4 E4 F4 E4 D4 C4 D4 G3',
  'E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 D4 C4 C4',
].join(' ');

export const MELODY: readonly number[] = ODE_TO_JOY.split(' ').map(noteToFrequency);
