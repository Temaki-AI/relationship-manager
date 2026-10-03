'use client';

import { createContext, useContext, useEffect, useRef } from 'react';

type BlockedTraversal = {
  delta: number;
  notify: (retry: () => void) => void;
};

type HistoryBlocker = {
  shouldBlock: () => boolean;
  onBlocked: (retry: () => void) => void;
};

type NavigationGuardContextValue = {
  registerHistoryBlocker: (blocker: HistoryBlocker) => () => void;
};

const HISTORY_POINT_KEY = '__bondsHistoryPoint';
const NavigationGuardContext = createContext<NavigationGuardContextValue | null>(null);

function readHistoryPoint(state: unknown): number | null {
  if (!state || typeof state !== 'object') return null;
  const value = (state as Record<string, unknown>)[HISTORY_POINT_KEY];
  return Number.isSafeInteger(value) ? value as number : null;
}

function withHistoryPoint(state: unknown, point: number): Record<string, unknown> {
  const record = state && typeof state === 'object'
    ? state as Record<string, unknown>
    : {};
  return { ...record, [HISTORY_POINT_KEY]: point };
}

export function NavigationGuardProvider({ children }: { children: React.ReactNode }) {
  const blockersRef = useRef(new Map<number, HistoryBlocker>());
  const currentPointRef = useRef(0);
  const contextRef = useRef<NavigationGuardContextValue | null>(null);

  if (!contextRef.current) {
    contextRef.current = {
      registerHistoryBlocker(blocker) {
        const point = readHistoryPoint(window.history.state) ?? currentPointRef.current;
        blockersRef.current.set(point, blocker);
        return () => {
          if (blockersRef.current.get(point) === blocker) {
            blockersRef.current.delete(point);
          }
        };
      },
    };
  }

  useEffect(() => {
    const originalPushState = window.history.pushState.bind(window.history);
    const originalReplaceState = window.history.replaceState.bind(window.history);
    let currentPoint = readHistoryPoint(window.history.state) ?? 0;
    currentPointRef.current = currentPoint;
    let restoringTraversal = false;
    let allowNextTraversal = false;
    let blockedTraversal: BlockedTraversal | null = null;

    originalReplaceState(
      withHistoryPoint(window.history.state, currentPoint),
      '',
      window.location.href
    );

    window.history.pushState = function pushState(data, unused, url) {
      for (const point of blockersRef.current.keys()) {
        if (point > currentPoint) blockersRef.current.delete(point);
      }
      currentPoint += 1;
      currentPointRef.current = currentPoint;
      return originalPushState(withHistoryPoint(data, currentPoint), unused, url);
    };

    window.history.replaceState = function replaceState(data, unused, url) {
      return originalReplaceState(withHistoryPoint(data, currentPoint), unused, url);
    };

    function handlePopState(event: PopStateEvent) {
      const nextPoint = readHistoryPoint(event.state);
      if (nextPoint === null) return;

      if (restoringTraversal) {
        event.stopImmediatePropagation();
        restoringTraversal = false;
        currentPoint = nextPoint;
        currentPointRef.current = currentPoint;
        const restored = blockedTraversal;
        blockedTraversal = null;
        restored?.notify(() => {
          allowNextTraversal = true;
          window.history.go(restored.delta);
        });
        return;
      }

      if (allowNextTraversal) {
        allowNextTraversal = false;
        currentPoint = nextPoint;
        currentPointRef.current = currentPoint;
        return;
      }

      const delta = nextPoint - currentPoint;
      const blocker = blockersRef.current.get(currentPoint);
      if (delta !== 0 && blocker?.shouldBlock()) {
        event.stopImmediatePropagation();
        blockedTraversal = { delta, notify: blocker.onBlocked };
        restoringTraversal = true;
        window.history.go(-delta);
        return;
      }

      currentPoint = nextPoint;
      currentPointRef.current = currentPoint;
    }

    window.addEventListener('popstate', handlePopState, true);
    return () => {
      window.removeEventListener('popstate', handlePopState, true);
      window.history.pushState = originalPushState;
      window.history.replaceState = originalReplaceState;
    };
  }, []);

  return (
    <NavigationGuardContext.Provider value={contextRef.current}>
      {children}
    </NavigationGuardContext.Provider>
  );
}

export function useHistoryNavigationBlocker(blocker: HistoryBlocker) {
  const context = useContext(NavigationGuardContext);
  if (!context) {
    throw new Error('useHistoryNavigationBlocker must be used within NavigationGuardProvider');
  }

  const blockerRef = useRef(blocker);
  blockerRef.current = blocker;

  useEffect(() => context.registerHistoryBlocker({
    shouldBlock: () => blockerRef.current.shouldBlock(),
    onBlocked: (retry) => blockerRef.current.onBlocked(retry),
  }), [context]);
}
