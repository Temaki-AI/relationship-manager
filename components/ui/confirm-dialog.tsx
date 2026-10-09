'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { AlertTriangle, CalendarDays, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description: string;
  safetyNote: string;
  safetyTone: 'recovery' | 'irreversible';
  confirmLabel: string;
  actionTone?: 'standard' | 'destructive';
  pendingLabel?: string;
  pending?: boolean;
  confirmDisabled?: boolean;
  children?: ReactNode;
  secondaryLabel?: string;
  onSecondary?: () => void;
  onCancel: () => void;
  onConfirm: () => void;
};

export function ConfirmDialog({
  open,
  title,
  description,
  safetyNote,
  safetyTone,
  confirmLabel,
  actionTone = 'destructive',
  pendingLabel = 'Working...',
  pending = false,
  confirmDisabled = false,
  children,
  secondaryLabel,
  onSecondary,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);
  const pendingRef = useRef(pending);

  useEffect(() => {
    onCancelRef.current = onCancel;
    pendingRef.current = pending;
  }, [onCancel, pending]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    cancelRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !pendingRef.current) {
        event.preventDefault();
        onCancelRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;

      const controls = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ));
      if (controls.length === 0) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [open]);

  if (!open) return null;
  const SafetyIcon = safetyTone === 'recovery' ? ShieldCheck : AlertTriangle;
  const ActionIcon = actionTone === 'standard' ? CalendarDays : AlertTriangle;
  const safetyClasses = safetyTone === 'recovery'
    ? 'border-success/20 bg-success-soft text-success'
    : 'border-destructive/20 bg-danger-soft text-destructive';
  const safetyIconClasses = safetyTone === 'recovery' ? 'text-success' : 'text-destructive';

  return (
    <div
      className="fixed inset-0 z-[110] flex items-end justify-center bg-slate-950/45 p-3 backdrop-blur-[2px] sm:items-center sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className={`w-full max-w-md rounded-2xl border ${actionTone === 'standard' ? 'border-border' : 'border-destructive/20'} bg-card p-5 shadow-overlay animate-fade-in-up sm:p-6`}
      >
        <div className="flex items-start gap-3">
          <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full ${actionTone === 'standard' ? 'bg-secondary text-primary' : 'bg-danger-soft text-destructive'}`}>
            <ActionIcon className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold text-foreground">{title}</h2>
            <p id={descriptionId} className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {description}
            </p>
          </div>
        </div>
        <div className={`mt-4 flex items-start gap-2 rounded-xl border p-3 text-xs leading-relaxed ${safetyClasses}`}>
          <SafetyIcon className={`mt-0.5 h-4 w-4 flex-shrink-0 ${safetyIconClasses}`} aria-hidden="true" />
          <p>{safetyNote}</p>
        </div>
        {children}
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button ref={cancelRef} type="button" variant="outline" onClick={onCancel} disabled={pending} className="h-11 sm:h-9">
            Cancel
          </Button>
          {secondaryLabel && onSecondary && (
            <Button type="button" variant="secondary" onClick={onSecondary} disabled={pending} className="h-11 sm:h-9">
              {secondaryLabel}
            </Button>
          )}
          <Button type="button" variant={actionTone === 'standard' ? 'default' : 'destructive'} onClick={onConfirm} disabled={pending || confirmDisabled} className="h-11 sm:h-9">
            {pending ? pendingLabel : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
