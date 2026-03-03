export class TimeoutError extends Error {
  name = "TimeoutError";
  constructor(message: string) {
    super(message);
  }
}

export class AbortError extends Error {
  name = "AbortError";
  constructor(message = "Aborted") {
    super(message);
  }
}

// withTimeout now accepts an optional AbortSignal.
// If the signal fires before the timeout, the returned promise rejects
// immediately with AbortError — the caller's promise chain cleans up
// without waiting for the full timeout duration.
// Note: the underlying Tauri invoke() still runs to completion on the
// Rust side — JS cannot cancel an in-flight IPC call. What this prevents
// is JS promise chains accumulating and hanging over long sessions.
export async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  message: string,
  signal?: AbortSignal,
): Promise<T> {
  // Pre-flight: don't start if already aborted
  if (signal?.aborted) {
    return Promise.reject(new AbortError());
  }

  let timerId: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;

  const timeoutPromise = new Promise<T>((_, reject) => {
    timerId = setTimeout(() => reject(new TimeoutError(message)), ms);
  });

  // Only create abort-signal promise if a signal was provided
  const abortPromise: Promise<T> | null = signal
    ? new Promise<T>((_, reject) => {
        abortHandler = () => reject(new AbortError());
        signal.addEventListener("abort", abortHandler, { once: true });
      })
    : null;

  const races: Promise<T>[] = [p, timeoutPromise];
  if (abortPromise) races.push(abortPromise);

  try {
    return await Promise.race(races);
  } finally {
    clearTimeout(timerId);
    if (signal && abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
  }
}