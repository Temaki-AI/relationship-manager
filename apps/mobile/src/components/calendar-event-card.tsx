import { Text, StyleSheet } from 'react-native';
import { ActionButton, Surface } from './design-system';
import type { NativeCalendarEvent } from '@/data/calendar-events';
import { fonts, palette } from '@/theme';
import { calendarEventWhen } from '../../../../packages/domain/src/calendar-event-display';

export function CalendarEventCard({ event, onOpen }: { event: NativeCalendarEvent; onOpen?: () => void }) {
  return <Surface style={styles.card}>
    <Text style={styles.title}>{event.facts.title}</Text>
    <Text style={styles.body}>{calendarEventWhen(event.facts, event.timeZone)}</Text>
    {event.facts.status !== 'confirmed' && <Text style={styles.status}>{event.facts.status === 'cancelled' ? 'Cancelled · saved context retained' : 'Tentative'}</Text>}
    {!!event.facts.location && <Text style={styles.body}>{event.facts.location}</Text>}
    <Text style={styles.body}>{event.calendarLabel} · {event.accountEmail}</Text>
    <Text style={styles.body}>Last downloaded {new Date(event.observedAt).toLocaleString()}</Text>
    {event.sourceStatus !== 'available' && <Text style={styles.status}>{event.sourceStatus === 'unavailable' ? 'Source unavailable · saved details may be outdated' : 'Source access needs review · saved details retained'}</Text>}
    {(event.people.length > 0 || event.plans.length > 0) && <Text style={styles.body}>{event.people.length} linked people · {event.plans.length} linked plans</Text>}
    {!!event.linksState && <Text style={styles.status}>{event.linksState === 'conflict' ? 'Phone link choices need review' : 'Phone link choices waiting to sync'}</Text>}
    {event.facts.redacted && <Text style={styles.body}>Private event · details hidden</Text>}
    {!!onOpen && <ActionButton label="View meeting context" variant="secondary" onPress={onOpen} />}
  </Surface>;
}
const styles = StyleSheet.create({
  card: { padding: 20, gap: 12 }, title: { fontFamily: fonts.bodyDemi, fontSize: 20, color: palette.ink },
  body: { fontFamily: fonts.body, fontSize: 15, lineHeight: 22, color: palette.muted }, status: { fontFamily: fonts.bodyDemi, fontSize: 15, color: palette.ink },
});
