// Loaded on first use, not at import: only a multipart form, CSV upload or XML body needs them.
function memoize<T>(load: () => Promise<T>): () => Promise<T> {
  let loaded: Promise<T> | undefined;
  return () => (loaded ??= load());
}

export const loadFormidable = memoize(() => import('formidable'));
export const loadCsv = memoize(() => import('csv'));
export const loadFastXmlParser = memoize(() => import('fast-xml-parser'));

let fastXmlParser: Awaited<ReturnType<typeof loadFastXmlParser>> | undefined;

/** Loads fast-xml-parser for {@link loadedFastXmlParser}: an XML response function builds synchronously. */
export async function loadXmlBuilder(): Promise<void> {
  fastXmlParser ??= await loadFastXmlParser();
}

export const loadedFastXmlParser = () => fastXmlParser;
