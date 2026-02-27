export class TimeoutError extends Error {
  name = "TimeoutError";
  constructor(message: string) {
    super(message);
  }
}

export async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let id: any;
  const t = new Promise<T>((_, reject) => {
    id = setTimeout(() => reject(new TimeoutError(message)), ms);
  });

  try {
    return await Promise.race([p, t]);
  } finally {
    clearTimeout(id);
  }
}
