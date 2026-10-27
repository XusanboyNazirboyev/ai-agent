'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

const SOUND_KEY = 'ac_sound';
const THEME_KEY = 'ac_theme';

interface Preferences {
  sound: boolean;
  setSound: (value: boolean) => void;
  theme: Theme;
  setTheme: (value: Theme) => void;
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the choice lasts for this page view only.
  }
}

function applyTheme(theme: Theme): void {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

const PreferencesContext = createContext<Preferences | undefined>(undefined);

/** Per-browser interface preferences (never sent to the server). */
export function PreferencesProvider({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  const [sound, setSoundState] = useState(true);
  const [theme, setThemeState] = useState<Theme>('system');

  useEffect(() => {
    // Read after hydration so server and client first render agree.
    setSoundState(read(SOUND_KEY) !== 'off');
    const stored = read(THEME_KEY);
    const next = (THEMES as readonly string[]).includes(stored ?? '')
      ? (stored as Theme)
      : 'system';
    setThemeState(next);
    applyTheme(next);
  }, []);

  const setSound = useCallback((value: boolean) => {
    setSoundState(value);
    write(SOUND_KEY, value ? 'on' : 'off');
  }, []);
  const setTheme = useCallback((value: Theme) => {
    setThemeState(value);
    write(THEME_KEY, value);
    applyTheme(value);
  }, []);

  const value = useMemo(
    () => ({ sound, setSound, theme, setTheme }),
    [sound, setSound, theme, setTheme],
  );
  return (
    <PreferencesContext.Provider value={value}>
      {children}
    </PreferencesContext.Provider>
  );
}

export function usePreferences(): Preferences {
  const value = useContext(PreferencesContext);
  if (!value)
    throw new Error('usePreferences must be used inside PreferencesProvider');
  return value;
}
