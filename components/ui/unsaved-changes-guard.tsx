'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useHistoryNavigationBlocker } from '@/components/navigation-guard-provider';

export type UnsavedChangesGuardHandle = {
  discardAndReload: () => void;
};

type UnsavedChangesGuardProps = {
  active: boolean;
  onDiscard: () => void;
  onKeep?: () => boolean;
};

export const UnsavedChangesGuard = forwardRef<UnsavedChangesGuardHandle, UnsavedChangesGuardProps>(
  function UnsavedChangesGuard({ active, onDiscard, onKeep }, ref) {
    const allowNavigationRef = useRef(false);
    const activeRef = useRef(active);
    const [pendingNavigation, setPendingNavigation] = useState<
      { type: 'url'; destination: string } | { type: 'history'; retry: () => void } | null
    >(null);
    activeRef.current = active;

    useHistoryNavigationBlocker({
      shouldBlock: () => activeRef.current && !allowNavigationRef.current,
      onBlocked: (retry) => setPendingNavigation({ type: 'history', retry }),
    });

    useImperativeHandle(ref, () => ({
      discardAndReload() {
        allowNavigationRef.current = true;
        window.location.reload();
      },
    }), []);

    useEffect(() => {
      if (!active) {
        allowNavigationRef.current = false;
        setPendingNavigation(null);
        return;
      }

      function handleBeforeUnload(event: BeforeUnloadEvent) {
        if (allowNavigationRef.current) return;
        event.preventDefault();
        event.returnValue = '';
      }

      function handleLinkClick(event: MouseEvent) {
        if (
          allowNavigationRef.current
          || event.defaultPrevented
          || event.button !== 0
          || event.metaKey
          || event.ctrlKey
          || event.shiftKey
          || event.altKey
          || !(event.target instanceof Element)
        ) {
          return;
        }

        const anchor = event.target.closest<HTMLAnchorElement>('a[href]');
        if (!anchor || anchor.hasAttribute('download') || (anchor.target && anchor.target !== '_self')) {
          return;
        }

        const destination = new URL(anchor.href, window.location.href);
        const current = new URL(window.location.href);
        if (
          destination.origin === current.origin
          && destination.pathname === current.pathname
          && destination.search === current.search
        ) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        setPendingNavigation({ type: 'url', destination: destination.href });
      }

      window.addEventListener('beforeunload', handleBeforeUnload);
      document.addEventListener('click', handleLinkClick, true);
      return () => {
        window.removeEventListener('beforeunload', handleBeforeUnload);
        document.removeEventListener('click', handleLinkClick, true);
      };
    }, [active]);

    function discardAndContinue() {
      if (!pendingNavigation) return;
      const navigation = pendingNavigation;
      setPendingNavigation(null);
      onDiscard();
      if (navigation.type === 'history') {
        navigation.retry();
      } else {
        allowNavigationRef.current = true;
        window.location.assign(navigation.destination);
      }
    }

    function keepAndContinue() {
      if (!pendingNavigation || !onKeep?.()) return;
      const navigation = pendingNavigation;
      setPendingNavigation(null);
      allowNavigationRef.current = true;
      if (navigation.type === 'history') navigation.retry();
      else window.location.assign(navigation.destination);
    }

    return (
      <ConfirmDialog
        open={pendingNavigation !== null}
        title="Discard unsaved changes?"
        description="This contact draft has changes that have not been saved."
        safetyNote={onKeep
          ? 'Keep this draft in this browser tab for up to 24 hours, or discard it now. Photos are not kept in the draft.'
          : 'Leaving now permanently discards this draft. Your previously saved CRM data will not be changed.'}
        safetyTone="irreversible"
        confirmLabel="Discard changes"
        secondaryLabel={onKeep ? 'Keep draft and leave' : undefined}
        onSecondary={onKeep ? keepAndContinue : undefined}
        onCancel={() => setPendingNavigation(null)}
        onConfirm={discardAndContinue}
      />
    );
  }
);
