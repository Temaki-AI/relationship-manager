import { NextResponse } from 'next/server';
import db from '@/lib/db';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { contact_id } = body;

    db.prepare(
      'INSERT OR IGNORE INTO contact_group_members (contact_id, group_id) VALUES (?, ?)'
    ).run(contact_id, id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to add member:', error);
    return NextResponse.json({ error: 'Failed to add member' }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const contactId = searchParams.get('contact_id');

    if (!contactId) {
      return NextResponse.json({ error: 'contact_id required' }, { status: 400 });
    }

    db.prepare(
      'DELETE FROM contact_group_members WHERE contact_id = ? AND group_id = ?'
    ).run(contactId, id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to remove member:', error);
    return NextResponse.json({ error: 'Failed to remove member' }, { status: 500 });
  }
}
