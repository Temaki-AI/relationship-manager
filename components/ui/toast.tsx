'use client';

import { createContext, useCallback, useContext, useState } from 'react';
import { CheckCircle, AlertCircle, Info, X } from 'lucide-react';

type ToastVariant = 'success' | 'error' | 'info';

type Toast = {
  id: number;
  message: string;
  variant: ToastVariant;
  leaving?: boolean;
};

type ToastContextValue = {
  toast: (opts: { message: string; variant?: ToastVariant }) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

let nextId = 0;

const variantStyles: Record<ToastVariant, { bg: string; icon: React.ElementType; iconColor: string }> = {
  success: { bg: 'bg-success-soft border-success/20 text-success', icon: CheckCircle, iconColor: 'text-success' },
  error: { bg: 'bg-danger-soft border-destructive/20 text-destructive', icon: AlertCircle, iconColor: 'text-destructive' },
  info: { bg: 'bg-info-soft border-info/20 text-info', icon: Info, iconColor: 'text-info' },
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback(({ message, variant = 'success' }: { message: string; variant?: ToastVariant }) => {
    const id = ++nextId;
    setToasts([{ id, message, variant }]);

    setTimeout(() => {
      setToasts(prev => prev.map(t => t.id === id ? { ...t, leaving: true } : t));
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== id));
      }, 300);
    }, 3000);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts(prev => prev.map(t => t.id === id ? { ...t, leaving: true } : t));
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 300);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {/* Toast Container */}
      <div className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] left-4 right-4 md:bottom-6 md:left-auto md:right-6 z-[100] flex flex-col gap-2 md:w-full md:max-w-sm pointer-events-none">
        {toasts.map((t) => {
          const style = variantStyles[t.variant];
          const Icon = style.icon;
          return (
            <div
              key={t.id}
              role={t.variant === 'error' ? 'alert' : 'status'}
              aria-live={t.variant === 'error' ? 'assertive' : 'polite'}
              className={`pointer-events-auto flex items-center gap-2.5 px-4 py-3 rounded-xl border shadow-overlay text-sm font-medium transition-all duration-300 ${style.bg} ${
                t.leaving ? 'opacity-0 translate-y-2' : 'animate-fade-in-up'
              }`}
            >
              <Icon className={`w-4 h-4 flex-shrink-0 ${style.iconColor}`} />
              <span className="flex-1">{t.message}</span>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                className="flex h-11 w-11 items-center justify-center rounded-lg hover:bg-black/5 flex-shrink-0"
                aria-label="Dismiss notification"
              >
                <X className="w-3.5 h-3.5 opacity-50" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
