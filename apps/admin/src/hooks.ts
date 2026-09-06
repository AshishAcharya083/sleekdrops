import { useCallback, useEffect, useRef, useState } from 'react';
import { captureError } from './analytics';
import { api } from './api';

/** Poll a GET endpoint on an interval; realtime-enough for a light admin. */
export function usePoll<T>(path: string, intervalMs = 4000): {
  data: T | null;
  error: string | null;
  refresh: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const load = useCallback(() => {
    api<T>(path)
      .then((d) => {
        if (!alive.current) return;
        setData(d);
        setError(null);
      })
      .catch((e: Error) => {
        captureError(e, { route: path, action: 'poll' });
        if (alive.current) setError(e.message);
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
