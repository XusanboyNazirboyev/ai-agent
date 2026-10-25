'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useI18n } from '@/i18n';
import { Icon } from './icons';

interface ToastItem {
  id: number;
  message: string;
}

const Context = createContext<((message: string) => void) | undefined>(
  undefined,
);

/** Polite, non-blocking confirmations. Errors stay in alert banners. */
export function ToastProvider({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  const { t } = useI18n();
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const notify = useCallback(
    (message: string) => {
      const id = (next.current += 1);
      setItems((current) => [...current.slice(-2), { id, message }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), 4_000),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return (): void => {
      for (const timer of pending.values()) clearTimeout(timer);
    };
  }, []);

  const value = useMemo(() => notify, [notify]);
  return (
    <Context.Provider value={value}>
      {children}
      <div
        role="status"
        aria-live="polite"
        data-testid="toasts"
        className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4"
      >
        {items.map((item) => (
          <div
            key={item.id}
            className="toast-in pointer-events-auto flex max-w-md items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-sm text-fg shadow-pop"
          >
            <span className="text-success-fg">
              <Icon name="check" />
            </span>
            <span>{item.message}</span>
            <button
              type="button"
              aria-label={t('toast.dismiss')}
              onClick={() => dismiss(item.id)}
              className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-surface-2"
            >
              <Icon name="x" />
            </button>
          </div>
        ))}
      </div>
    </Context.Provider>
  );
}

export function useToast(): (message: string) => void {
  const value = useContext(Context);
  if (!value) throw new Error('useToast needs a ToastProvider');
  return value;
}
