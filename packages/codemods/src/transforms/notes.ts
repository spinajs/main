import { NewLineKind, type Node, type SourceFile } from 'ts-morph';

/** Puts each note on its own line above the node, indented like it; a line that already holds the note is left alone. */
export function insertNotes(file: SourceFile, notes: Array<{ node: Node; note: string }>): boolean {
  const text = file.getFullText();
  const byLine = new Map<number, string>();

  for (const { node, note } of notes) {
    const lineStart = text.lastIndexOf('\n', node.getStart() - 1) + 1;
    const previousLine = text.slice(text.lastIndexOf('\n', lineStart - 2) + 1, Math.max(lineStart - 1, 0)).trim();
    if (previousLine !== note) {
      byLine.set(lineStart, note);
    }
  }
  if (byLine.size === 0) {
    return false;
  }

  const crlf = text.includes('\r\n');
  let out = text;
  // from the end, so the earlier offsets stay valid
  for (const [lineStart, note] of [...byLine].sort(([a], [b]) => b - a)) {
    const indent = /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? '';
    out = `${out.slice(0, lineStart)}${indent}${note}${crlf ? '\r\n' : '\n'}${out.slice(lineStart)}`;
  }

  // ts-morph rewrites every newline of the text it is given to the project's newline kind
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
