/**
 * Race work against a wall-clock deadline.
 *
 * The shape exists because "abort it and rely on the caller noticing" is not a
 * timeout. An AbortController only asks: if the thing being aborted is an
 * async iterator that never yields again, the `await` in front of it never
 * settles, every `finally` behind it is never reached, and the timer that was
 * supposed to bound the call has already done all it can. A stage held by one
 * of those used to sit in 'running' until the container was recycled.
 *
 * So the deadline settles the promise the caller is actually waiting on, and
 * `onExpiry` runs inside the timer - the cleanup (abort, close the stream) and
 * the error to reject with are both produced there, on the timeout path
 * itself, rather than in a `finally` that may never run.
 *
 * What it cannot do is stop the work: a JavaScript promise has no cancel. The
 * loser of the race keeps going until its own guard fires, which is why the
 * abandoned promise gets a no-op `catch` - without it, a rejection arriving
 * after the race is an unhandled rejection, and the process dies of the
 * timeout it was supposed to survive.
 */
export async function withDeadline<T>(
  timeoutMs: number,
  run: () => Promise<T>,
  onExpiry: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const pending = run();
  pending.catch(() => {
    /* the race's loser is nobody's failure to handle */
  });
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // Cleanup that throws must still produce a timeout: an exception out
          // of a timer callback is uncaught, and takes the process with it.
          let expiry: Error;
          try {
            expiry = onExpiry();
          } catch (err) {
            expiry = err instanceof Error ? err : new Error(String(err));
          }
          reject(expiry);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
