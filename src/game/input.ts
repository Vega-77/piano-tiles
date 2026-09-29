/** The longest wait between a touch and the page hearing of it that is made up for, in seconds. */
const MAX_EVENT_AGE = 0.3;

/**
 * How long ago, in seconds, an input event really happened. The page only hears of a touch or a key once its main thread
 * gets round to it, which after a slow frame can be well after the finger landed; a tap is graded at the moment it
 * happened, not the moment it was heard. An event whose time can't be used (not on the page's clock, or from the future,
 * or so long ago that something else is wrong) counts as happening just now.
 */
export function eventAge(event: { timeStamp: number }, now: number = performance.now()): number {
  const age = (now - event.timeStamp) / 1000;
  return age > 0 && age <= MAX_EVENT_AGE ? age : 0;
}
