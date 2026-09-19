import { useEffect, useState } from 'react';

/**
 * A value that settles `delayMs` after the input stops changing.
 *
 * Used by search. Debouncing the VALUE rather than the request is what makes
 * the query key lag-free: React Query sees one stable key per settled query, so
 * it cancels the in-flight request itself (the `signal` it hands `queryFn` goes
 * straight to the SDK) instead of racing a second one it does not know about.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    if (Object.is(value, settled)) return;
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, settled, delayMs]);

  return settled;
}
