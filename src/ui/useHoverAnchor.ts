/**
 * Hover tracking for a list of rows: instant open, short close grace so the
 * pointer can travel between adjacent rows without the card blinking.
 * Separate from HoverCard.tsx so both files stay fast-refreshable.
 */
import React from "react";
import type { HoverCardAnchor } from "./components/HoverCard";

export function useHoverAnchor(closeDelayMs = 80) {
  const [anchor, setAnchor] = React.useState<
    (HoverCardAnchor & { key: string }) | null
  >(null);
  const timer = React.useRef<number | null>(null);

  const clearTimer = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const open = React.useCallback((key: string, el: HTMLElement) => {
    clearTimer();
    setAnchor({ key, rect: el.getBoundingClientRect() });
  }, []);

  const close = React.useCallback(
    (key?: string) => {
      clearTimer();
      timer.current = window.setTimeout(() => {
        setAnchor((current) =>
          key === undefined || current?.key === key ? null : current,
        );
      }, closeDelayMs);
    },
    [closeDelayMs],
  );

  /** Scrolling the list invalidates the anchor rect immediately. */
  const dismiss = React.useCallback(() => {
    clearTimer();
    setAnchor(null);
  }, []);

  React.useEffect(() => clearTimer, []);

  return { anchor, open, close, dismiss };
}
