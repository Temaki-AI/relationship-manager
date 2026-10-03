export type PickedPhoneContact = {
  name?: string[];
  email?: string[];
  tel?: string[];
};

export type PhoneContactsManager = {
  getProperties(): Promise<string[]>;
  select(properties: string[], options: { multiple: boolean }): Promise<PickedPhoneContact[]>;
};

export function getPhoneContactsManager(navigatorValue: Navigator): PhoneContactsManager | null {
  const contacts = (navigatorValue as Navigator & { contacts?: PhoneContactsManager }).contacts;
  return contacts && typeof contacts.getProperties === 'function' && typeof contacts.select === 'function'
    ? contacts
    : null;
}

function uniqueValues(values: string[] | undefined): string[] {
  return Array.from(new Set((values || []).map((value) => value.trim()).filter(Boolean)));
}

function escapeVCardValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

export function buildPhoneContactsVCard(contacts: PickedPhoneContact[]): string {
  return contacts
    .map((contact) => {
      const names = uniqueValues(contact.name);
      const emails = uniqueValues(contact.email);
      const phones = uniqueValues(contact.tel);
      const displayName = names[0] || emails[0] || phones[0];
      if (!displayName) return null;

      return [
        'BEGIN:VCARD',
        'VERSION:3.0',
        `FN:${escapeVCardValue(displayName)}`,
        ...emails.map((email) => `EMAIL:${escapeVCardValue(email)}`),
        ...phones.map((phone) => `TEL:${escapeVCardValue(phone)}`),
        'END:VCARD',
      ].join('\r\n');
    })
    .filter((card): card is string => Boolean(card))
    .join('\r\n');
}
