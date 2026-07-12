import React, { createContext, useContext } from 'react';
import { darkTerminalTheme, type Theme } from './tokens';

const ThemeContext = createContext<Theme>(darkTerminalTheme);

export interface ThemeProviderProps {
  children: React.ReactNode;
  theme?: Theme;
}

export function ThemeProvider({ children, theme = darkTerminalTheme }: ThemeProviderProps): React.JSX.Element {
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
