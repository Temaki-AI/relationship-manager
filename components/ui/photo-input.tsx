'use client';

import { useState } from 'react';
import { FileImage, ShieldCheck, Trash2 } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  CONTACT_PHOTO_DIMENSION,
  isEmbeddedContactPhoto,
  MAX_CONTACT_PHOTO_SOURCE_BYTES,
  MAX_EMBEDDED_CONTACT_PHOTO_CHARACTERS,
} from '@/lib/contact-photo';
import { getAvatarColor, getInitials } from '@/lib/utils';

type PhotoInputProps = {
  id: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
};

const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function loadLocalImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('This image could not be opened.'));
    image.src = url;
  });
}

async function createEmbeddedPhoto(file: File): Promise<string> {
  if (!SUPPORTED_IMAGE_TYPES.has(file.type)) {
    throw new Error('Choose a JPEG, PNG, or WebP image.');
  }
  if (file.size > MAX_CONTACT_PHOTO_SOURCE_BYTES) {
    throw new Error('Choose an image smaller than 10 MB.');
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadLocalImage(objectUrl);
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('This image has no usable pixels.');

    for (const dimension of [CONTACT_PHOTO_DIMENSION, 256, 192]) {
      const canvas = document.createElement('canvas');
      canvas.width = dimension;
      canvas.height = dimension;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('This browser cannot process local photos.');

      const sourceSize = Math.min(image.naturalWidth, image.naturalHeight);
      const sourceX = (image.naturalWidth - sourceSize) / 2;
      const sourceY = (image.naturalHeight - sourceSize) / 2;
      context.fillStyle = '#fffaf7';
      context.fillRect(0, 0, dimension, dimension);
      context.drawImage(
        image,
        sourceX,
        sourceY,
        sourceSize,
        sourceSize,
        0,
        0,
        dimension,
        dimension
      );

      for (const quality of [0.84, 0.7, 0.56, 0.42]) {
        const result = canvas.toDataURL('image/jpeg', quality);
        if (result.length <= MAX_EMBEDDED_CONTACT_PHOTO_CHARACTERS && isEmbeddedContactPhoto(result)) {
          return result;
        }
      }
    }
  } finally {
    URL.revokeObjectURL(objectUrl);
  }

  throw new Error('This photo could not be reduced to a safe storage size.');
}

export function PhotoInput({ id, name, value, onChange }: PhotoInputProps) {
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const embeddedPhoto = isEmbeddedContactPhoto(value) ? value : null;
  const hasInertRemotePhoto = Boolean(value && !embeddedPhoto);
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setProcessing(true);
    setError(null);
    try {
      onChange(await createEmbeddedPhoto(file));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'This photo could not be processed.');
    } finally {
      setProcessing(false);
    }
  }

  return (
    <div>
      <Label htmlFor={id}>Photo</Label>
      <div className="mt-2 flex items-center gap-3">
        {embeddedPhoto ? (
          <div className="h-16 w-16 flex-shrink-0 overflow-hidden rounded-2xl shadow-sm">
            {/* The source is restricted to a validated local data image. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={embeddedPhoto} alt="Contact photo preview" className="h-full w-full object-cover" />
          </div>
        ) : (
          <div className={`flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-full ${getAvatarColor(name || 'Contact')} text-lg font-semibold`}>
            {getInitials(name || 'Contact')}
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <input
            id={id}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            disabled={processing}
            aria-describedby={`${descriptionId}${error ? ` ${errorId}` : ''}`}
            onChange={async (event) => {
              await handleFile(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
          <label
            htmlFor={id}
            className={buttonVariants({ variant: 'outline', size: 'sm', className: processing ? 'pointer-events-none opacity-50' : '' })}
            aria-disabled={processing}
          >
            <FileImage className="h-3.5 w-3.5" aria-hidden="true" />
            {processing ? 'Preparing photo...' : embeddedPhoto ? 'Replace photo' : 'Choose photo'}
          </label>
          {value && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-destructive"
              onClick={() => {
                onChange('');
                setError(null);
              }}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              Remove
            </Button>
          )}
        </div>
      </div>
      <p id={descriptionId} className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-emerald-600" aria-hidden="true" />
        Photos are cropped, resized, and stripped of metadata in this browser before being stored inside your Everclose CRM database.
      </p>
      {hasInertRemotePhoto && (
        <p className="mt-2 rounded-lg border border-amber-200/70 bg-warning-soft/50 px-3 py-2 text-[11px] leading-relaxed text-amber-800">
          A remote photo URL is stored for compatibility but is not loaded, protecting your IP address and viewing activity. Upload a local photo to replace it.
        </p>
      )}
      {error && <p id={errorId} role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}
