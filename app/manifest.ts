import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Everclose CRM - Personal Relationship Manager',
    short_name: 'Everclose',
    id: '/',
    description: 'Remember what matters and stay close to the people who matter.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#fffaf7',
    theme_color: '#cb1a41',
    orientation: 'any',
    categories: ['lifestyle', 'productivity'],
    shortcuts: [
      {
        name: 'Your people',
        short_name: 'Contacts',
        description: 'Open your relationship directory.',
        url: '/contacts',
      },
      {
        name: 'Add a contact',
        short_name: 'Add contact',
        description: 'Capture someone while the context is fresh.',
        url: '/contacts/new',
      },
      {
        name: 'Reminders',
        short_name: 'Reminders',
        description: 'See the follow-ups that need your attention.',
        url: '/reminders',
      },
    ],
    icons: [
      {
        src: '/icons/bonds-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/bonds-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'maskable',
      },
    ],
  };
}
