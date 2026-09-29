import { CloudError } from './errors';

export const NAME_MIN = 3;
export const NAME_MAX = 16;

/** What a name may be made of. (firestore.rules checks the same, so a client that skips this still can't get round it.) */
const NAME = /^[A-Za-z0-9_-]+$/;

/** The name as it is compared: two names that differ only in capitals are the same name. */
export const nameKey = (name: string): string => name.toLowerCase();

/** The name to use from what was typed, or a `CloudError` saying what is wrong with it. */
export function parseName(input: string): string {
  const name = input.trim();
  if (name.length < NAME_MIN || name.length > NAME_MAX) throw new CloudError(`A name has ${NAME_MIN} to ${NAME_MAX} characters.`);
  if (!NAME.test(name)) throw new CloudError('A name can have letters, numbers, dashes and underscores, but no spaces.');
  return name;
}
