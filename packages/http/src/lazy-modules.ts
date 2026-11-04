// Loaded on first use, not at import: only a multipart form, CSV upload or XML body needs them.
/** Memoises `load`, but forgets a rejection so a transient failure (EMFILE, ...) is retried on the next call. */
export function memoize<T>(load: () => Promise<T>): () => Promise<T> {
  let loaded: Promise<T> | undefined;
  return () =>
    (loaded ??= load().catch((err) => {
      loaded = undefined;
      throw err;
    }));
}

export const loadFormidable = memoize(() => import('formidable'));
export const loadCsv = memoize(() => import('csv'));

type FastXmlParser = typeof import('fast-xml-parser');
const importFastXmlParser = (): Promise<FastXmlParser> => import('fast-xml-parser');

export let loadFastXmlParser = memoize(importFastXmlParser);

let fastXmlParser: FastXmlParser | undefined;

/** Loads fast-xml-parser for {@link loadedFastXmlParser}: an XML response function builds synchronously. */
export async function loadXmlBuilder(): Promise<void> {
  fastXmlParser ??= await loadFastXmlParser();
}

export const loadedFastXmlParser = () => fastXmlParser;

/** Test-only: forgets the loaded builder so the next XML response loads it again, optionally through `importer`. */
export function resetXmlBuilder(importer: () => Promise<FastXmlParser> = importFastXmlParser): void {
  fastXmlParser = undefined;
  loadFastXmlParser = memoize(importer);
}
