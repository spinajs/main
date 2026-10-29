import ts from 'typescript';
import type { ScheduleEntry } from '@spinajs/manifest';
import type { Extractor } from '../context.js';
import { findDecorator, literalValue } from '../decorators.js';
import { stringArg } from './string-arg.js';

export const extractSchedules: Extractor<ScheduleEntry> = (ctx, file) => {
  const out: ScheduleEntry[] = [];
  for (const st of file.statements) {
    if (!ts.isClassDeclaration(st) || !st.name) continue;
    const d = findDecorator(st, 'Schedule');
    if (!d) continue;
    out.push({
      name: stringArg(d.args[0], ctx, st.name.text),
      className: st.name.text,
      options: (literalValue(d.args[1], ctx) ?? {}) as Record<string, unknown>,
      source: ctx.sourceRef(st),
    });
  }
  return out;
};
