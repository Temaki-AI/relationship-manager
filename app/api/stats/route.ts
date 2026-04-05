import { NextResponse } from 'next/server';
import { calculateDaysUntilBirthday } from '@/lib/birthdays';
import db from '@/lib/db';
import { addDays, differenceInDays, format, parseISO } from 'date-fns';

export async function GET() {
  try {
    // Total contacts
    const { total } = db.prepare(
      'SELECT COUNT(*) as total FROM contacts'
    ).get() as { total: number };

    // Conversations this week
    const weekAgo = format(addDays(new Date(), -7), 'yyyy-MM-dd');
    const { thisWeek } = db.prepare(
      'SELECT COUNT(*) as thisWeek FROM interactions WHERE date >= ?'
    ).get(weekAgo) as { thisWeek: number };

    // Neglected contacts (>30 days since last contact)
    const allContacts = db.prepare(
      'SELECT id, last_contacted, contact_frequency FROM contacts'
    ).all() as Array<{ id: number; last_contacted: string | null; contact_frequency: number }>;

    const now = new Date();
    const neglected = allContacts.filter(c => {
      if (!c.last_contacted) return false;
      const daysSince = differenceInDays(now, parseISO(c.last_contacted));
      return daysSince > (c.contact_frequency || 14) * 2;
    });

    // Upcoming birthdays (next 30 days)
    const upcomingBirthdays = db.prepare(
      `SELECT id, name, birthday FROM contacts 
       WHERE birthday IS NOT NULL`
    ).all() as Array<{ id: number; name: string; birthday: string }>;

    const birthdays = upcomingBirthdays.filter(c => {
      const daysUntil = calculateDaysUntilBirthday(now, c.birthday);
      return daysUntil >= 0 && daysUntil <= 30;
    }).map(c => {
      const daysUntil = calculateDaysUntilBirthday(now, c.birthday);
      return { ...c, daysUntil };
    }).sort((a, b) => a.daysUntil - b.daysUntil);

    // Action items: contacts to reach out to
    const actionItems = allContacts
      .filter(c => c.last_contacted)
      .map(c => {
        const daysSince = differenceInDays(now, parseISO(c.last_contacted!));
        const targetDays = c.contact_frequency || 14;
        const overdue = daysSince - targetDays;
        return { id: c.id, daysSince, overdue };
      })
      .filter(c => c.overdue > 0)
      .sort((a, b) => b.overdue - a.overdue)
      .slice(0, 5);

    return NextResponse.json({
      stats: {
        totalContacts: total,
        conversationsThisWeek: thisWeek,
        neglectedCount: neglected.length,
        upcomingBirthdaysCount: birthdays.length,
      },
      actionItems: actionItems.map(a => a.id),
      upcomingBirthdays: birthdays,
    });
  } catch (error) {
    console.error('GET /api/stats error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch stats' },
      { status: 500 }
    );
  }
}
