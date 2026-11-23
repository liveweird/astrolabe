/**
 * A promise a test settles by hand: the gate behind a stub response that must stay pending (or answer late) until the test says so, in place of a
 * real-time delay. `resolve`/`reject` are idempotent like the promise itself.
 */
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
