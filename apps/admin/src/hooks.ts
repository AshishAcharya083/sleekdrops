import { useCallback, useEffect, useRef, useState } from 'react';
import { captureError } from './analytics';
import { api } from './api';
import { toApiError, type ApiError } from './api-error';

/**
 * Poll a GET endpoint on an interval; realtime-enough for a light admin.
 *
 * A failed poll never discards the payload the page is already showing: a tab
 * renders the last good data with the error banner above it, so one transient
 * 500 in the 4s loop cannot empty the screen. The error is the classified
 * ApiError, so the banner can name the cause instead of guessing.
 */
export function usePoll<T>(path: string, intervalMs = 4000): {
  data: T | null;
  error: ApiError | null;
  refresh: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const alive = useRef(true);

  const load = useCallback(() => {
    api<T>(path)
      .then((d) => {
        if (!alive.current) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        captureError(e, { route: path, action: 'poll' });
        if (alive.current) setError(toApiError(e));
      });
  }, [path]);

  useEffect(() => {
    alive.current = true;
    load();
    const t = setInterval(load, intervalMs);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [load, intervalMs]);

  return { data, error, refresh: load };
}
