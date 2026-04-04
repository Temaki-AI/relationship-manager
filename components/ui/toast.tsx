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
  success: { bg: 'bg-emerald-50 border-emerald-200 text-emerald-800', icon: CheckCircle, iconColor: 'text-emerald-500' },
  error: { bg: 'bg-red-50 border-red-200 text-red-800', icon: AlertCircle, iconColor: 'text-red-500' },
  info: { bg: 'bg-blue-50 border-blue-200 text-blue-800', icon: Info, iconColor: 'text-blue-500' },
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback(({ message, variant = 'success' }: { message: string; variant?: ToastVariant }) => {
    const id = ++nextId;
    setToasts(prev => [...prev, { id, message, variant }]);

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
      <div className="fixed bottom-20 sm:bottom-6 right-4 sm:right-6 z-[100] flex flex-col gap-2 max-w-sm w-full pointer-events-none">
        {toasts.map((t) => {
          const style = variantStyles[t.variant];
          const Icon = style.icon;
          return (
            <div
              key={t.id}
              className={`pointer-events-auto flex items-center gap-2.5 px-4 py-3 rounded-xl border shadow-lg text-sm font-medium transition-all duration-300 ${style.bg} ${
                t.leaving ? 'opacity-0 translate-y-2' : 'animate-fade-in-up'
              }`}
            >
              <Icon className={`w-4 h-4 flex-shrink-0 ${style.iconColor}`} />
              <span className="flex-1">{t.message}</span>
              <button
                onClick={() => dismiss(t.id)}
                className="p-0.5 rounded hover:bg-black/5 flex-shrink-0"
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
