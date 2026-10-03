'use client';

import { useState } from 'react';
import { getContactAvatar } from '@/lib/utils';

type AvatarProps = {
  contact: {
    name: string;
    email?: string | null;
    photo_url?: string | null;
  };
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
};

const sizeClasses = {
  sm: 'w-8 h-8 text-xs',
  md: 'w-12 h-12 text-base',
  lg: 'w-20 h-20 text-2xl',
  xl: 'w-24 h-24 text-3xl',
};

export function Avatar({ contact, size = 'md', className = '' }: AvatarProps) {
  const [imageError, setImageError] = useState(false);
  const avatar = getContactAvatar({
    name: contact.name,
    email: contact.email || null,
    photo_url: contact.photo_url || null,
  });

  // If image failed to load or no image available, show initials
  if (avatar.type === 'initials' || imageError) {
    return (
      <div
        className={`${sizeClasses[size]} rounded-full sm:rounded-2xl bg-slate-800 bg-gradient-to-br ${avatar.color} flex items-center justify-center text-white font-bold shadow-lg flex-shrink-0 ${className}`}
      >
        {avatar.initials}
      </div>
    );
  }

  // Show image with fallback to initials on error
  return (
    <div className={`${sizeClasses[size]} rounded-full sm:rounded-2xl overflow-hidden shadow-lg flex-shrink-0 ${className}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={avatar.url}
        alt={contact.name}
        loading="lazy"
        referrerPolicy="no-referrer"
        className="w-full h-full object-cover"
        onError={() => setImageError(true)}
      />
    </div>
  );
}
