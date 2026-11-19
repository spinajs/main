import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration-common';
import type { ExplainOptions } from './types.js';

export const DEFAULT_EXPLAIN_OPTIONS: Readonly<ExplainOptions> = {
  Enabled: false,
  SlowQueryMs: 200,
  MaxPerMinute: 10,
  CaptureBindings: false,
};

/** `db.Explain` over the defaults. Without a resolved Configuration (tooling, bare driver tests) the capture stays off. */
export function explainOptions(): ExplainOptions {
  const configured = DI.get(Configuration)?.get<Partial<ExplainOptions>>('db.Explain');
  return { ...DEFAULT_EXPLAIN_OPTIONS, ...(configured ?? {}) };
}
