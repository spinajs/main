import type ts from 'typescript';
import type { SourceRef } from '@spinajs/manifest';
import type { ExtractorContext } from '../context.js';

export interface IgnoreComment {
  code: string;
  reason: string;
  source: SourceRef;
}

/** Ignore comments by the file text; `pattern` is global and captures the code, then the reason. */
export function ignoreCommentsIn(files: readonly ts.SourceFile[], ctx: ExtractorContext, pattern: RegExp): IgnoreComment[] {
  return files.flatMap((file) =>
    [...file.text.matchAll(pattern)].map((m) => {
      const { line, character } = file.getLineAndCharacterOfPosition(m.index);
      return { code: m[1], reason: m[2], source: { ...ctx.sourceRef(file), line: line + 1, col: character + 1 } };
    }),
  );
}
