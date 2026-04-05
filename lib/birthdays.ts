import { differenceInCalendarDays, startOfDay } from 'date-fns';

export function calculateDaysUntilBirthday(now: Date, birthday: string): number {
  const [, monthString, dayString] = birthday.split('-');
  const month = Number(monthString) - 1;
  const day = Number(dayString);

  let nextBirthday = new Date(now.getFullYear(), month, day);
  if (differenceInCalendarDays(startOfDay(nextBirthday), startOfDay(now)) < 0) {
    nextBirthday = new Date(now.getFullYear() + 1, month, day);
  }

  return differenceInCalendarDays(startOfDay(nextBirthday), startOfDay(now));
}
