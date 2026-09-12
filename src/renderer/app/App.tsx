import { useEffect } from "react";
import { observeScrolling } from "../styles/scrollbars";
import {
  CommandPalette,
  DesktopShell,
  ThemeProvider,
} from "../shell";
import { ShortcutProvider } from "../shortcuts";
import { ToastProvider } from "../feedback";

export function App() {
  useEffect(() => observeScrolling(document), []);
  return (
    <ThemeProvider>
      <ToastProvider>
        <ShortcutProvider>
          <DesktopShell />
          <CommandPalette />
        </ShortcutProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
