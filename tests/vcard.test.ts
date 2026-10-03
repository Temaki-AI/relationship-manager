import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeVCardContact,
  parseVCards,
  serializeContactsToVCard,
} from '../lib/vcard.ts';
import type { Contact } from '../lib/db.ts';
import { TINY_PNG_DATA_URL } from './fixtures.ts';

test('vCard parsing handles common Google and Apple contact fields', () => {
  const cards = parseVCards(`BEGIN:VCARD\r
VERSION:3.0\r
FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Jos=C3=A9 Lovelace\r
NICKNAME:Pepe\r
EMAIL;TYPE=PREF,INTERNET:JOSE@EXAMPLE.TEST\r
EMAIL:jose.work@example.test\r
TEL;TYPE=CELL:+49 123 456789\r
TEL;TYPE=WORK:+49 987 654321\r
BDAY:19901231\r
ORG:Analytical\\; Engines;Research\r
TITLE:Principal Mathematician\r
ADR;TYPE=HOME:;;12 Logic Lane;Berlin;;10115;Germany\r
CATEGORIES:friend\\,close,work\r
NOTE:Met at the conference and discussed\r
 follow-up plans.\\nPrefers email.\r
URL;TYPE=linkedin:https://www.linkedin.com/in/jose-lovelace\r
PHOTO:data:image/svg+xml,unsafe\r
END:VCARD`);

  assert.equal(cards.length, 1);
  assert.equal(cards[0].name, 'José Lovelace');
  assert.equal(cards[0].nickname, 'Pepe');
  assert.deepEqual(cards[0].emails, ['jose@example.test', 'jose.work@example.test']);
  assert.deepEqual(cards[0].phones, ['+49 123 456789', '+49 987 654321']);
  assert.equal(cards[0].birthday, '1990-12-31');
  assert.equal(cards[0].organization, 'Analytical; Engines / Research');
  assert.equal(cards[0].location, '12 Logic Lane, Berlin, 10115, Germany');
  assert.deepEqual(cards[0].categories, ['friend,close', 'work']);
  assert.match(cards[0].notes || '', /follow-up plans\.\nPrefers email/);
  assert.equal(cards[0].socialLinks.linkedin, 'https://www.linkedin.com/in/jose-lovelace');
  assert.equal(cards[0].photoUrl, null);

  const normalized = normalizeVCardContact(cards[0], '2026-07-10T12:00:00.000Z');
  assert.equal(normalized.name, 'José Lovelace');
  assert.equal(normalized.contact_frequency, 30);
  assert.deepEqual(JSON.parse(normalized.tags || '[]'), ['friend / close', 'work']);
  const customFields = JSON.parse(normalized.custom_fields || '{}');
  assert.equal(customFields.company, 'Analytical; Engines / Research');
  assert.deepEqual(customFields.vcard.additional_emails, ['jose.work@example.test']);
});

test('vCard parsing falls back to structured names and rejects incomplete cards', () => {
  const [contact] = parseVCards(`BEGIN:VCARD\nVERSION:3.0\nN:Lovelace;Ada;Byron;Countess;\nEND:VCARD`);
  assert.equal(contact.name, 'Countess Ada Byron Lovelace');
  assert.throws(() => parseVCards('BEGIN:VCARD\nFN:Ada'), /END marker/i);
  assert.throws(() => parseVCards('not a vcard'), /No vCard contacts/i);
});

test('vCard normalization derives names from organization, email, or phone', () => {
  const contacts = parseVCards(`BEGIN:VCARD
ORG:Acme Labs
END:VCARD
BEGIN:VCARD
EMAIL:hello@example.test
END:VCARD
BEGIN:VCARD
TEL:+1 555 0100
END:VCARD`);

  assert.deepEqual(contacts.map((contact) => normalizeVCardContact(contact).name), [
    'Acme Labs',
    'hello@example.test',
    '+1 555 0100',
  ]);
  assert.throws(
    () => normalizeVCardContact(parseVCards('BEGIN:VCARD\nUID:empty\nEND:VCARD')[0]),
    /no usable identity/i
  );
});

test('vCard unfolding distinguishes quoted-printable soft breaks from base64 padding', () => {
  const [contact] = parseVCards(`BEGIN:VCARD\r
VERSION:3.0\r
FN;ENCODING=QUOTED-PRINTABLE:Jos=C3=\r
=A9 Lovelace\r
END:VCARD`);
  assert.equal(contact.name, 'José Lovelace');
});

test('oversized nonstandard vCard photos are omitted without rejecting the contact', () => {
  const oversizedPhoto = 'A'.repeat(3_000);
  const [contact] = parseVCards(`BEGIN:VCARD
FN:Photo Heavy Contact
EMAIL:photo@example.test
PHOTO:${oversizedPhoto}
END:VCARD`);

  assert.equal(contact.photoUrl, null);
  assert.equal(normalizeVCardContact(contact).name, 'Photo Heavy Contact');
  assert.equal(normalizeVCardContact(contact).photo_url, null);
});

test('Bonds vCard export round-trips portable contact fields', () => {
  const contact: Contact = {
    id: 7,
    name: 'Ada Lovelace',
    nickname: 'Enchantress of Numbers',
    email: 'ada@example.test',
    phone: '+44 20 1234 5678',
    photo_url: 'https://images.example.test/ada.jpg',
    birthday: '1815-12-10',
    birthday_reminder_days: 14,
    how_we_met: 'Math salon',
    tags: '["friend","science"]',
    notes: 'Enjoys engines, poetry; and long notes. '.repeat(5),
    gift_ideas: '["Rare book"]',
    custom_fields: JSON.stringify({
      company: 'Analytical Engines',
      job_title: 'Programmer',
      location: 'London',
      social: { website: 'https://example.test/ada' },
      vcard: {
        additional_emails: ['ada.work@example.test'],
        additional_phones: ['+44 20 5555 0102'],
      },
    }),
    last_contacted: '2026-07-09',
    contact_frequency: 21,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-07-09T12:00:00.000Z',
  };

  const serialized = serializeContactsToVCard([contact]);
  assert.match(serialized, /\r\n /, 'long content lines should be folded');
  assert.match(serialized, /PHOTO;VALUE=URI:https:\/\/images\.example\.test\/ada\.jpg/);
  assert.match(serialized, /X-BONDS-CUSTOM-FIELDS:/);

  const [roundTripped] = parseVCards(serialized);
  assert.equal(roundTripped.name, contact.name);
  assert.equal(roundTripped.nickname, contact.nickname);
  assert.deepEqual(roundTripped.emails, ['ada@example.test', 'ada.work@example.test']);
  assert.deepEqual(roundTripped.phones, ['+44 20 1234 5678', '+44 20 5555 0102']);
  assert.equal(roundTripped.birthday, contact.birthday);
  assert.equal(roundTripped.birthdayReminderDays, contact.birthday_reminder_days);
  assert.deepEqual(roundTripped.categories, ['friend', 'science']);
  assert.deepEqual(roundTripped.giftIdeas, ['Rare book']);
  assert.equal(roundTripped.contactFrequency, 21);
  assert.equal(roundTripped.lastContacted, '2026-07-09');
  assert.equal(roundTripped.photoUrl, contact.photo_url);
  assert.deepEqual(roundTripped.customFields, JSON.parse(contact.custom_fields || '{}'));
  const normalized = normalizeVCardContact(roundTripped);
  assert.equal(normalized.photo_url, contact.photo_url);
  assert.deepEqual(JSON.parse(normalized.custom_fields || '{}'), JSON.parse(contact.custom_fields || '{}'));

  const embeddedPhotoVCard = serializeContactsToVCard([{ ...contact, photo_url: TINY_PNG_DATA_URL }]);
  assert.match(embeddedPhotoVCard, /PHOTO;ENCODING=b;TYPE=PNG:/);
  const [withEmbeddedPhoto] = parseVCards(embeddedPhotoVCard);
  assert.equal(withEmbeddedPhoto.photoUrl, TINY_PNG_DATA_URL);
});
