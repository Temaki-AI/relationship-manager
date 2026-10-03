'use client';

import { createAuthClient } from 'better-auth/react';

export const cloudAuthClient = createAuthClient({
  baseURL: typeof window === 'undefined' ? undefined : window.location.origin,
});
