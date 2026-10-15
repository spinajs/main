import type { RunEvent } from '../contract.js';

export function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r.at(i) ?? '').length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (c ?? '').padEnd(widths.at(i) ?? 0))
      .join('  ')
      .trimEnd();
  return [line(header), ...rows.map(line)];
}

export function when(iso: string | null): string {
  return iso ? iso.replace('T', ' ').replace(/\.\d{3}Z$/, 'Z') : '-';
}

export function duration(ms: number | null): string {
  if (ms === null) return '-';
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 100) / 10;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

export function formatEvent(e: RunEvent): string {
  const t = e.ts.slice(11, 19);
  switch (e.type) {
    case 'status':
      return `${t} status   ${e.status}${e.reason ? ` (${e.reason})` : ''}`;
    case 'step-start':
      return `${t} step     > ${e.step}`;
    case 'step-end':
      return `${t} step     < ${e.step} ${e.status} in ${duration(e.durationMs)}${
        e.error ? `: ${e.error.message}` : ''
      }`;
    case 'progress':
      return `${t} progress ${e.progress}%${e.step ? ` [${e.step} ${e.stepProgress ?? 0}%]` : ''}${
        e.message ? ` ${e.message}` : ''
      }`;
    case 'message':
      return `${t} message  ${e.message}`;
    case 'log':
      return `${t} ${e.level.padEnd(8)} ${e.message}`;
    case 'error':
      return `${t} error    ${e.error.name}: ${e.error.message}`;
  }
}
