export type DataCapability = {
  id: 'vcard' | 'csv' | 'encrypted-backup' | 'linkedin-extension' | 'linkedin-link';
  label: string;
  description: string;
  privacy: string;
  status: 'available' | 'optional';
  href: string;
  actionLabel: string;
};

export const DATA_CAPABILITIES: readonly DataCapability[] = [
  {
    id: 'linkedin-link', label: 'LinkedIn profile links', status: 'available', href: '/connections/linkedin', actionLabel: 'Link a profile',
    description: 'Attach a LinkedIn profile to an existing person or create a person from it, keeping the original details for review.',
    privacy: 'You supply the URL and details. Everclose does not fetch LinkedIn or automatically change your contact name.',
  },
  {
    id: 'vcard',
    label: 'vCard address books',
    description: 'Import and export standard .vcf files from Apple, Google, Outlook, and other contact apps.',
    privacy: 'Files are processed by this Everclose CRM deployment and are not sent to a third-party enrichment service.',
    status: 'available',
    href: '/contacts',
    actionLabel: 'Transfer vCards',
  },
  {
    id: 'csv',
    label: 'CSV spreadsheets',
    description: 'Bring in a contact spreadsheet or export a portable, spreadsheet-safe copy of your people.',
    privacy: 'Files are validated before contacts are saved. In cloud mode, possible duplicates require your decision.',
    status: 'available',
    href: '/contacts',
    actionLabel: 'Transfer CSV files',
  },
  {
    id: 'encrypted-backup',
    label: 'Encrypted Everclose CRM backups',
    description: 'Create a complete portable backup protected by a passphrase only you know.',
    privacy: 'Encryption and decryption happen in your browser; the passphrase is never stored or sent to the server.',
    status: 'available',
    href: '/settings',
    actionLabel: 'Manage encrypted backups',
  },
  {
    id: 'linkedin-extension',
    label: 'LinkedIn browser capture',
    description: 'Import the profile you are viewing with the separately installed Everclose CRM browser extension.',
    privacy: 'Optional and explicit: profile data is not sent to Everclose CRM until you click Import Contact in the extension.',
    status: 'optional',
    href: '/contacts',
    actionLabel: 'View captured contacts',
  },
] as const;

export const AUTOMATIC_ACCOUNT_SYNC = {
  enabled: false,
  message: 'Google, Microsoft, email, and calendar data are not read automatically when you sign in. Source connections, imports and recurring reads each require separate choices.',
} as const;
