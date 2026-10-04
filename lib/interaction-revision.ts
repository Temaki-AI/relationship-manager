import { createHash } from 'crypto';
import type Database from 'better-sqlite3';
import type { Interaction } from './db.ts';
import { recalculateLastContacted } from './relationship-mutations.ts';

const INTERACTION_EDIT_REVISION_PATTERN = /^[a-f0-9]{64}$/;

type InteractionUpdateInput = {
  date: string;
  type: string;
  summary: string | null;
  notes: string | null;
};

export type InteractionWithEditRevision = Interaction & {
  edit_revision: string;
};

export type InteractionUpdateResult =
  | { status: 'updated'; interaction: InteractionWithEditRevision }
  | { status: 'conflict'; editRevision: string }
  | { status: 'not-found' };

export class InteractionRevisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InteractionRevisionError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function getExpectedInteractionRevision(value: unknown): string {
  if (!isRecord(value) || typeof value.expected_edit_revision !== 'string') {
    throw new InteractionRevisionError('Refresh this interaction before saving changes.');
  }
  const revision = value.expected_edit_revision.trim().toLowerCase();
  if (!INTERACTION_EDIT_REVISION_PATTERN.test(revision)) {
    throw new InteractionRevisionError('Refresh this interaction before saving changes.');
  }
  return revision;
}

export function getInteractionEditRevision(interaction: Interaction): string {
  return createHash('sha256').update(JSON.stringify([
    interaction.contact_id,
    interaction.date,
    interaction.type,
    interaction.summary,
    interaction.notes,
    interaction.occurred_at ?? null,
  ])).digest('hex');
}

export function withInteractionEditRevision(
  interaction: Interaction
): InteractionWithEditRevision {
  return {
    ...interaction,
    edit_revision: getInteractionEditRevision(interaction),
  };
}

export function updateInteractionIfCurrent(
  db: Database.Database,
  interactionId: number,
  input: InteractionUpdateInput,
  expectedRevision: string
): InteractionUpdateResult {
  const update = db.transaction((): InteractionUpdateResult => {
    const current = db.prepare('SELECT * FROM interactions WHERE id = ?')
      .get(interactionId) as Interaction | undefined;
    if (!current) return { status: 'not-found' };

    const currentRevision = getInteractionEditRevision(current);
    if (currentRevision !== expectedRevision) {
      return { status: 'conflict', editRevision: currentRevision };
    }

    db.prepare(
      'UPDATE interactions SET date = ?, type = ?, summary = ?, notes = ? WHERE id = ?'
    ).run(input.date, input.type, input.summary, input.notes, interactionId);
    recalculateLastContacted(db, current.contact_id);

    const interaction = db.prepare('SELECT * FROM interactions WHERE id = ?')
      .get(interactionId) as Interaction;
    return { status: 'updated', interaction: withInteractionEditRevision(interaction) };
  });

  return update.immediate();
}
