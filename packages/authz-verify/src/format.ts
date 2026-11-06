import type { TupleSubjectRef } from '@spinajs/authz-ir';

import type { Counterexample } from './verdict.js';
import type { AssertionResult, VerifyDiagnostic } from './assertions.js';

export type VerifyFormat = 'text' | 'json' | 'github';

const GITHUB_LEVEL: Record<VerifyDiagnostic['severity'], string> = { error: 'error', warning: 'warning', info: 'notice' };
const TEXT_LEVEL: Record<VerifyDiagnostic['severity'], string> = { error: 'fail', warning: 'warn', info: 'ok' };

// GitHub workflow-command escaping; '%' must go first.
const escapeData = (s: string): string => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProp = (s: string): string => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

const ref = (o: { type: string; id: string }): string => `${o.type}:${o.id}`;
const subject = (s: TupleSubjectRef): string => `${ref(s)}${s.relation === undefined ? '' : `#${s.relation}`}${s.caveat === undefined ? '' : ` with ${s.caveat.name}`}`;

/** `principal user:u1 with org:o1#accountant@user:u1 gets invoice:read allow, invoice:approve deny on invoice:i1` */
export function describeCounterexample(cx: Counterexample): string {
  const tuples = cx.tuples.map((t) => `${ref(t.object)}#${t.relation}@${subject(t.subject)}`);
  const answers = Object.entries(cx.outcome).map(([p, truth]) => `${p} ${truth}`);
  const context = cx.context === undefined ? '' : ` and context ${JSON.stringify(cx.context)}`;
  return `principal ${ref(cx.principal)}${tuples.length > 0 ? ` with ${tuples.join(', ')}` : ''}${context} gets ${answers.join(', ')} on ${ref(cx.resource)}`;
}

export function summarize(results: readonly AssertionResult[]): { error: number; warning: number; info: number } {
  const out = { error: 0, warning: 0, info: 0 };
  for (const r of results) for (const d of r.diagnostics) out[d.severity]++;
  return out;
}

/** The doctor's output shapes (`compiler/src/doctor/format.ts`): one line per diagnostic, then a summary. */
export function formatResults(results: readonly AssertionResult[], format: VerifyFormat): string[] {
  const diagnostics = results.flatMap((r) => r.diagnostics);
  if (format === 'json') return [JSON.stringify({ results, summary: summarize(results) })];
  if (format === 'github') return diagnostics.map((d) => `::${GITHUB_LEVEL[d.severity]} title=${escapeProp(`${d.code} ${d.assertion}`)}::${escapeData(d.counterexample === undefined ? d.message : `${d.message}: ${describeCounterexample(d.counterexample)}`)}`);
  const width = Math.max(0, ...diagnostics.map((d) => d.assertion.length));
  const lines: string[] = [];
  for (const d of diagnostics) {
    lines.push(`${TEXT_LEVEL[d.severity].padEnd(4)} ${d.code} ${d.assertion.padEnd(width)}  ${d.message}`);
    if (d.counterexample !== undefined) lines.push(`     ${describeCounterexample(d.counterexample)}`);
  }
  const s = summarize(results);
  lines.push(`${s.error} error(s), ${s.warning} warning(s), ${s.info} info`);
  return lines;
}
