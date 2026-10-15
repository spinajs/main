import sinon from 'sinon';

export function captureConsole() {
  const lines: string[] = [];
  const errors: string[] = [];
  const log = sinon.stub(console, 'log').callsFake((...a: unknown[]) => void lines.push(a.join(' ')));
  const err = sinon.stub(console, 'error').callsFake((...a: unknown[]) => void errors.push(a.join(' ')));
  return {
    lines,
    errors,
    json: <T = unknown>(): T => JSON.parse(lines.join('\n')) as T,
    restore: () => {
      log.restore();
      err.restore();
    },
  };
}
