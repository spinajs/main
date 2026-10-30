import type { Diagnostic } from '@spinajs/manifest';
import type { DeriveContext } from './derive.js';

export function diagnose(ctx: DeriveContext, code: 'SCH001' | 'SCH002' | 'SCH004' | 'SCH005' | 'SCH006', severity: Diagnostic['severity'], message: string): void {
  const owner = ctx.options.foreignOwner?.(ctx.node);
  ctx.diagnostics.push({ code, severity, message: owner ? `${message} (declared in ${owner})` : message, source: ctx.options.sourceRef?.(ctx.node) });
}
