import { NewLineKind, type Node, type SourceFile } from 'ts-morph';

/** Puts each note on its own line above the node and its JSDoc, indented like it; a line that already holds the note is left alone. */
export function insertNotes(file: SourceFile, notes: Array<{ node: Node; note: string }>): boolean {
  const text = file.getFullText();
  const byLine = new Map<number, string>();

  for (const { node, note } of notes) {
    const lineStart = text.lastIndexOf('\n', node.getStart(true) - 1) + 1;
    const previousLine = text.slice(text.lastIndexOf('\n', lineStart - 2) + 1, Math.max(lineStart - 1, 0)).trim();
    if (previousLine !== note) {
      byLine.set(lineStart, note);
    }
  }
  if (byLine.size === 0) {
    return false;
  }

  // ts-morph writes one newline kind for the whole text, so a mixed file keeps the one most of its lines use
  const crlfCount = text.split('\r\n').length - 1;
  const crlf = crlfCount > text.split('\n').length - 1 - crlfCount;
  let out = text;
  // from the end, so the earlier offsets stay valid
  for (const [lineStart, note] of [...byLine].sort(([a], [b]) => b - a)) {
    const indent = /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? '';
    out = `${out.slice(0, lineStart)}${indent}${note}${crlf ? '\r\n' : '\n'}${out.slice(lineStart)}`;
  }

  const settings = file.getProject().manipulationSettings;
  const previous = settings.getNewLineKind();
  settings.set({ newLineKind: crlf ? NewLineKind.CarriageReturnLineFeed : NewLineKind.LineFeed });
  try {
    file.replaceWithText(out);
  } finally {
    settings.set({ newLineKind: previous });
  }
  return true;
}
