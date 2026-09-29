/** Something that went wrong adding or changing a song, worded for the person who asked. */
export class ImportError extends Error {}

/** Adding a song was cancelled by the person adding it. */
export class Cancelled extends Error {
  constructor() {
    super('Cancelled.');
  }
}
