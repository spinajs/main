import ts from 'typescript';
import type { MigrationEntry } from '@spinajs/manifest';
import type { Extractor } from '../context.js';
import { findDecorator, literalValue } from '../decorators.js';
import { stringArg } from './string-arg.js';

export const extractMigrations: Extractor<MigrationEntry> = (ctx, file) => {
  const out: MigrationEntry[] = [];
  for (const st of file.statements) {
    if (!ts.isClassDeclaration(st) || !st.name) continue;
    const d = findDecorator(st, 'Migration');
    if (!d) continue;
    const options = (literalValue(d.args[1], ctx) ?? {}) as { Env?: string | string[] };
    const env = options.Env === undefined ? undefined : Array.isArray(options.Env) ? options.Env : [options.Env];
    const source = ctx.sourceRef(st);
    out.push({
      id: `${ctx.packageName}:${st.name.text}`,
      className: st.name.text,
      connection: stringArg(d.args[0], ctx),
      ...(env ? { env } : {}),
      file: source.file,
      source,
    });
  }
  return out;
};
