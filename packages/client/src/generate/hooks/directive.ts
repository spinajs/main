const HEADER_COMMENT = /^\/\*[\s\S]*?\*\/\n/;

/** Makes `'use client'` the first statement; a comment may precede a directive, so the header stays on top. */
export function withUseClient(contents: string): string {
  const header = HEADER_COMMENT.exec(contents)?.[0] ?? '';
  return `${header}'use client';\n${contents.slice(header.length)}`;
}
