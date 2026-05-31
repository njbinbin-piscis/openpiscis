import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type RefObject,
  type UIEvent,
} from "react";

type Options = {
  containerRef: RefObject<HTMLDivElement | null>;
  itemCount: number;
  hasMore: boolean;
  setLoading: (loading: boolean) => void;
  loadOlder: () => Promise<void>;
  active?: boolean;
};

/**
 * Scroll-up pagination for lists that prepend older items (chat, pool, inbox).
 * Restores scroll position after prepend via useLayoutEffect; auto-fills short viewports.
 */
export function useScrollPrependedHistory({
  containerRef,
  itemCount,
  hasMore,
  setLoading,
  loadOlder,
  active = true,
}: Options) {
  const scrollRestoreRef = useRef<number | null>(null);
  const loadingMoreRef = useRef(false);

  const triggerLoadOlder = useCallback(async () => {
    if (!active || !hasMore || loadingMoreRef.current) return;
    const el = containerRef.current;
    scrollRestoreRef.current = el ? el.scrollHeight : 0;
    loadingMoreRef.current = true;
    setLoading(true);
    try {
      await loadOlder();
    } catch {
      scrollRestoreRef.current = null;
      loadingMoreRef.current = false;
      setLoading(false);
    }
  }, [active, hasMore, loadOlder, setLoading, containerRef]);

  useLayoutEffect(() => {
    if (scrollRestoreRef.current == null) return;
    const el = containerRef.current;
    if (!el) return;
    const prevScrollHeight = scrollRestoreRef.current;
    scrollRestoreRef.current = null;
    el.scrollTop = Math.max(0, el.scrollHeight - prevScrollHeight);
    loadingMoreRef.current = false;
    setLoading(false);
  }, [itemCount, setLoading, containerRef]);

  const handleScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      if (!active) return;
      if (e.currentTarget.scrollTop < 60) {
        void triggerLoadOlder();
      }
    },
    [active, triggerLoadOlder],
  );

  useEffect(() => {
    if (!active || !hasMore || loadingMoreRef.current) return;
    const el = containerRef.current;
    if (!el) return;
    if (el.scrollHeight - el.clientHeight > 8) return;
    void triggerLoadOlder();
  }, [active, hasMore, itemCount, triggerLoadOlder, containerRef]);

  /** Call when a load returned no new rows (itemCount unchanged). */
  const cancelPendingRestore = useCallback(() => {
    scrollRestoreRef.current = null;
    loadingMoreRef.current = false;
    setLoading(false);
  }, [setLoading]);

  return { handleScroll, loadOlder: triggerLoadOlder, cancelPendingRestore, loadingMoreRef };
}
