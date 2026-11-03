/** Memoises `load`, but forgets a rejection so a transient failure (EMFILE, ...) is retried on the next call. */
export function lazyImport<T>(load: () => Promise<T>): () => Promise<T> {
  let loaded: Promise<T> | undefined;
  return () =>
    (loaded ??= load().catch((err) => {
      loaded = undefined;
      throw err;
    }));
}
