import { NextResponse } from 'next/server';
import db from '@/lib/db';
import type { Contact } from '@/lib/db';

export async function GET() {
  try {
    const contacts = db.prepare('SELECT * FROM contacts ORDER BY name').all() as Contact[];

    // CSV headers
    const headers = [
      'Name',
      'Email',
      'Phone',
      'Birthday',
      'How We Met',
      'Tags',
      'Notes',
      'Gift Ideas',
      'Last Contacted',
      'Contact Frequency (days)',
      'Created At',
    ];

    // Build CSV rows
    const rows = contacts.map((c) => [
      c.name,
      c.email || '',
      c.phone || '',
      c.birthday || '',
      c.how_we_met || '',
      c.tags || '',
      c.notes || '',
      c.gift_ideas || '',
      c.last_contacted || '',
      c.contact_frequency.toString(),
      c.created_at,
    ]);

    // Escape CSV values
    const escape = (val: string) => {
      if (val.includes(',') || val.includes('"') || val.includes('\n')) {
        return `"${val.replace(/"/g, '""')}"`;
      }
      return val;
    };

    const csvContent = [
      headers.join(','),
      ...rows.map((row) => row.map(escape).join(',')),
    ].join('\n');

    return new NextResponse(csvContent, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="contacts-${new Date().toISOString().split('T')[0]}.csv"`,
      },
    });
  } catch (error) {
    console.error('Failed to export CSV:', error);
    return NextResponse.json({ error: 'Failed to export CSV' }, { status: 500 });
  }
}
