import type { Contact } from './db.ts';

export type DirectoryContact = Pick<Contact,
  'id' | 'name' | 'nickname' | 'email' | 'phone' | 'photo_url' | 'tags' | 'last_contacted' | 'contact_frequency'> & {
  company: string | null;
  location: string | null;
};

function customText(path: string): string {
  return `CASE WHEN json_type(contacts.custom_fields, '${path}') = 'text'
    THEN json_extract(contacts.custom_fields, '${path}') END`;
}

export const DIRECTORY_CONTACT_COLUMNS = `
  contacts.id, contacts.name, contacts.nickname, contacts.email, contacts.phone,
  CASE WHEN substr(contacts.photo_url, 1, 5) = 'data:'
    THEN '/api/contacts/' || contacts.id || '/photo' ELSE contacts.photo_url END AS photo_url,
  contacts.tags, contacts.last_contacted, contacts.contact_frequency,
  CASE WHEN json_valid(contacts.custom_fields) THEN
    COALESCE(${customText('$.company')}, ${customText('$.linkedin.company')}) END AS company,
  CASE WHEN json_valid(contacts.custom_fields) THEN
    COALESCE(${customText('$.location')}, ${customText('$.linkedin.location')}) END AS location
`;
