import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { captureError } from './analytics';
import { api, getPlatform, onPlatformChange, type PlatformInfo } from './api';
import { toApiError, type ApiError } from './api-error';

/** The selected platform. App.tsx renders no page until there is one. */
export const PlatformContext = createContext<PlatformInfo | null>(null);

export function usePlatform(): PlatformInfo {
  const platform = useContext(PlatformContext);
  if (!platform) throw new Error('usePlatform() used outside the selected platform');
  return platform;
}

/**
 * Poll a GET endpoint on an interval; realtime-enough for a light admin.
 *
 * A failed poll never discards the payload the page is already showing: a tab
 * renders the last good data with the error banner above it, so one transient
 * 500 in the 4s loop cannot empty the screen. The error is the classified
 * ApiError, so the banner can name the cause instead of guessing.
 *
 * A platform switch is the one thing that does discard it: the payload belongs
 * to the platform it was fetched for, so the switch empties it and a response
 * still in flight for the previous platform is dropped when it lands.
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
    const requestedFor = getPlatform();
    api<T>(path)
      .then((d) => {
        if (!alive.current || getPlatform() !== requestedFor) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        captureError(e, { route: path, action: 'poll' });
        if (alive.current && getPlatform() === requestedFor) setError(toApiError(e));
      });
  }, [path]);

  useEffect(
    () =>
      onPlatformChange(() => {
        setData(null);
        setError(null);
      }),
    [],
  );

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
