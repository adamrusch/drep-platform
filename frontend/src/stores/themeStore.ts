import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export type Theme = 'light' | 'dark';

interface ThemeStore {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
}

/**
 * Persisted theme preference. The active theme is mirrored to
 * `document.documentElement.dataset.theme` from a `useEffect` in `App.tsx`,
 * which activates the `[data-theme="dark"]` block in `design-system.css`.
 */
export const useThemeStore = create<ThemeStore>()(
  persist(
    (set, get) => ({
      theme: 'light',
      setTheme: (theme) => set({ theme }),
      toggle: () => set({ theme: get().theme === 'light' ? 'dark' : 'light' }),
    }),
    {
      name: 'drep:theme',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
