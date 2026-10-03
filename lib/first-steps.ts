import { parseStoredTags } from './tag-validation.ts';

export const FIRST_CIRCLE_TAG = 'Close circle';
export const MAX_FIRST_CIRCLE_SIZE = 5;

type FirstStepsContact = {
  id: number;
  name: string;
  tags: string | null;
  birthday: string | null;
};

type FirstStepsActivity = {
  interactionsCount: number;
};

export type FirstStepsSnapshot = {
  circleCount: number;
  circlePeople: Array<{ id: number; name: string; birthdayKnown: boolean }>;
  hasLoggedMoment: boolean;
};

export function buildFirstSteps(
  contacts: readonly FirstStepsContact[],
  activity: ReadonlyMap<number, FirstStepsActivity>
): FirstStepsSnapshot {
  const members = contacts.filter((contact) => parseStoredTags(contact.tags)
    .some((tag) => tag.toLowerCase() === FIRST_CIRCLE_TAG.toLowerCase()));
  const circlePeople = members
    .map((contact) => ({ id: contact.id, name: contact.name, birthdayKnown: Boolean(contact.birthday) }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id)
    .slice(0, MAX_FIRST_CIRCLE_SIZE);

  return {
    circleCount: members.length,
    circlePeople,
    hasLoggedMoment: Array.from(activity.values()).some((item) => item.interactionsCount > 0),
  };
}
