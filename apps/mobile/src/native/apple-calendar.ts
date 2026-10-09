import { Platform } from 'react-native';
import * as Calendar from 'expo-calendar/legacy';
import { requireNativeModule } from 'expo';
import { readAppleCalendarFacts } from '../../../../packages/domain/src/apple-calendar';
import type { AppleCalendarAdapter } from '@/data/apple-calendar';

type FactsModule = { get: (id: string) => Promise<unknown | null>; calendars: AppleCalendarAdapter['calendars']; find: (calendarId: string, start: string, end: string, url: string) => Promise<unknown[]> };
function ios() { if (Platform.OS !== 'ios') throw new Error('The system Calendar bridge is available on iPhone and iPad.'); }
function factsModule() { ios(); return requireNativeModule<FactsModule>('EvercloseCalendarFacts'); }
async function permission(request: boolean) {
  ios(); let value = await Calendar.getCalendarPermissionsAsync();
  if (request && value.status !== 'granted' && value.canAskAgain) value = await Calendar.requestCalendarPermissionsAsync();
  return value.status === 'granted';
}
export const appleCalendarAdapter: AppleCalendarAdapter = {
  async prepareEditor() {
    ios();
    const major = Number.parseInt(String(Platform.Version), 10);
    if (!Number.isFinite(major)) throw new Error('This iOS version could not be verified.');
    if (major < 17 && !await permission(true)) throw new Error('This iOS version needs Calendar permission to open its event editor.');
  },
  async create(event) { ios(); return Calendar.createEventInCalendarAsync(event); },
  permission,
  async get(id) { const value = await factsModule().get(id); return value === null ? null : readAppleCalendarFacts(value); },
  async calendars() { return factsModule().calendars(); },
  async find(calendarId, start, end, url) {
    const values = await factsModule().find(calendarId, new Date(start).toISOString(), new Date(end).toISOString(), url);
    if (!Array.isArray(values) || values.length > 5000) throw new Error('Too many Calendar results. Choose a smaller date window.');
    return values.map(readAppleCalendarFacts);
  },
  async edit(id) { ios(); return Calendar.editEventInCalendarAsync({ id }); },
};
