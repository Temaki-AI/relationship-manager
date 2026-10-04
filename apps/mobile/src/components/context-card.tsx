import { Text, View, StyleSheet } from 'react-native';
import { ActionButton, Surface } from './design-system';
import type { ContextRecord } from '@/data/context';
import type { ContextEntity } from '../../../../packages/domain/src/relationship-context';
import { fonts, palette } from '@/theme';

export function ContextCard({ entity, record, busy, onEdit, onRemove, onComplete, onPerson, onCalendar }: {
  entity: ContextEntity; record: ContextRecord; busy: boolean; onEdit: () => void; onRemove: () => void;
  onComplete?: () => void; onPerson?: (id: string) => void; onCalendar?: () => void;
}) {
  const connectedId = entity === 'family' ? record.linked_contact_id : record.other_contact_id;
  const connectedName = entity === 'family' ? record.linked_name : record.related_name;
  return <Surface style={styles.card}>
    <Text style={styles.title}>{String(entity === 'plan' ? record.summary || record.type : entity === 'family' ? record.name : record.related_name || 'Unavailable person')}</Text>
    {entity === 'plan' && <>
      <Text style={styles.body}>{String(record.planned_date)} · {String(record.type)}{record.completed_at ? ' · Completed' : ''}</Text>
      {!!record.contact_name && <ActionButton label={`Open ${record.contact_name}`} variant="quiet" onPress={() => onPerson?.(record.contact_id)} />}
      {!!record.notes && <Text style={styles.body}>{String(record.notes)}</Text>}
    </>}
    {entity === 'family' && !!record.birthday && <Text style={styles.body}>Birthday · {String(record.birthday)}</Text>}
    {entity === 'relationship' && <Text style={styles.body}>{String(record.display_label || record.relationship_label)}</Text>}
    {typeof connectedId === 'string' && <ActionButton label={`Open ${connectedName || 'linked profile'}`} variant="quiet" onPress={() => onPerson?.(connectedId)} />}
    {record.sync_state !== 'synced' && <Text style={styles.body}>{record.sync_state === 'conflict' ? 'Needs sync review' : 'Saved on this phone · waiting to sync'}</Text>}
    <View style={styles.actions}>
      <ActionButton label="Edit" variant="secondary" disabled={busy} onPress={onEdit} />
      <ActionButton label="Remove" variant="quiet" disabled={busy} onPress={onRemove} />
      {entity === 'plan' && onCalendar && <ActionButton label="Calendar" variant="secondary" disabled={busy} onPress={onCalendar} />}
    </View>
    {entity === 'plan' && !record.completed_at && onComplete && <ActionButton label="Confirm it happened" disabled={busy} onPress={onComplete} />}
  </Surface>;
}
const styles = StyleSheet.create({
  card: { padding: 20, gap: 12 }, actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  title: { fontFamily: fonts.bodyDemi, fontSize: 20, color: palette.ink }, body: { fontFamily: fonts.body, fontSize: 15, lineHeight: 22, color: palette.muted },
});
