import { createContext, useCallback, useContext, useEffect, useState } from 'react';

// Theme choice: 'system' (follow the device), 'light' or 'dark'. Remembered per
// device in localStorage (a convenience only — wrapped so private mode still works).
const KEY = 'suite.theme';
const ThemeContext = createContext({ mode: 'system', setMode: () => {} });

function readMode() {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

function applyMode(mode) {
  const root = document.documentElement;
  if (mode === 'system') delete root.dataset.theme;
  else root.dataset.theme = mode;
}

// Apply before React renders to avoid a flash of the wrong theme.
applyMode(readMode());

export function ThemeProvider({ children }) {
  const [mode, setModeState] = useState(readMode);

  useEffect(() => applyMode(mode), [mode]);

  const setMode = useCallback((next) => {
    setModeState(next);
    try {
      if (next === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      /* storage unavailable: the choice lasts until reload */
    }
  }, []);

  return <ThemeContext.Provider value={{ mode, setMode }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
