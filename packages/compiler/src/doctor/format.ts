import type { Diagnostic } from '@spinajs/manifest';

export type DoctorFormat = 'text' | 'json' | 'github';

const GITHUB_LEVEL: Record<Diagnostic['severity'], string> = { error: 'error', warning: 'warning', info: 'notice' };

export function summarize(diagnostics: Diagnostic[]): { error: number; warning: number; info: number } {
  const out = { error: 0, warning: 0, info: 0 };
  for (const d of diagnostics) out[d.severity]++;
  return out;
}

function location(d: Diagnostic): string {
  return d.source ? `${d.source.file}:${d.source.line}:${d.source.col}` : '';
}

export function formatDiagnostics(diagnostics: Diagnostic[], format: DoctorFormat): string[] {
  if (format === 'json') return [JSON.stringify({ diagnostics, summary: summarize(diagnostics) })];
  if (format === 'github') {
    return diagnostics.map((d) => {
      const at = d.source ? `file=${d.source.file},line=${d.source.line},col=${d.source.col},` : '';
      return `::${GITHUB_LEVEL[d.severity]} ${at}title=${d.code}::${d.message}`;
    });
  }
  const width = Math.max(0, ...diagnostics.map((d) => location(d).length));
  const lines = diagnostics.map((d) => `${d.severity.padEnd(7)} ${d.code.padEnd(8)} ${location(d).padEnd(width)}  ${d.message}`);
  const s = summarize(diagnostics);
  lines.push(`${s.error} error(s), ${s.warning} warning(s), ${s.info} info`);
  return lines;
}
