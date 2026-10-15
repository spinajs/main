import { expect } from 'chai';
import { computeFingerprint, normalizeMessage, topInAppFrame } from '../src/index.js';

const stack = (file: string, line: number) =>
  `Error: x\n    at Object.next (/srv/app/node_modules/pg/lib/client.js:10:3)\n    at node:internal/process/task_queues:95:5\n    at ImportRates.execute (${file}:${line}:17)\n    at RunExecutor.invoke (/srv/app/node_modules/@spinajs/scheduler/lib/mjs/run/RunExecutor.js:1:1)`;

describe('fingerprints', () => {
  it('normalizes volatile parts of messages', () => {
    expect(
      normalizeMessage(
        `Row 1234 of "rates-2026.csv" failed for 9f1c2a4e-3b7d-4c9e-8f00-5c4ed01e5c4e at /var/data/in/rates.csv (0xFF)`,
      ),
    ).to.eq('Row <n> of <str> failed for <uuid> at <path> (<hex>)');
    expect(normalizeMessage('timeout after 30000 ms')).to.eq(normalizeMessage('timeout after 45000 ms'));
  });

  it('finds the top in-app frame without line numbers or install path', () => {
    expect(topInAppFrame(stack('/srv/app/lib/tasks/ImportRates.js', 42))).to.eq('ImportRates.execute (ImportRates.js)');
    expect(topInAppFrame('Error: x')).to.eq(null);
  });

  it('groups the same failure across lines, hosts and values', () => {
    const a = computeFingerprint('import-rates', {
      name: 'Error',
      message: 'Row 12 failed',
      stack: stack('/srv/app/lib/tasks/ImportRates.js', 42),
    });
    const b = computeFingerprint('import-rates', {
      name: 'Error',
      message: 'Row 99 failed',
      stack: stack('C:\\deploy\\lib\\tasks\\ImportRates.js', 57),
    });
    expect(a).to.eq(b);
    expect(a).to.have.length(32);
    expect(
      computeFingerprint('other', { name: 'Error', message: 'Row 12 failed', stack: stack('/x/ImportRates.js', 1) }),
    ).to.not.eq(a);
    expect(
      computeFingerprint('import-rates', {
        name: 'TypeError',
        message: 'Row 12 failed',
        stack: stack('/x/ImportRates.js', 1),
      }),
    ).to.not.eq(a);
  });

  it('does not open a quoted string at an apostrophe inside a word', () => {
    expect(normalizeMessage("Can't resolve 'alpha'")).to.eq("Can't resolve <str>");
    expect(normalizeMessage("Can't resolve 'alpha'")).to.eq(normalizeMessage("Can't resolve 'beta'"));
    expect(normalizeMessage('user\'s key "a" missing')).to.eq("user's key <str> missing");
  });

  it('keeps unrelated messages and frames apart', () => {
    expect(normalizeMessage('connection refused')).to.not.eq(normalizeMessage('connection reset'));
    const at = (fn: string) => `Error: x\n    at ${fn} (/app/lib/Job.js:3:9)`;
    expect(topInAppFrame(at('Job.fetch'))).to.not.eq(topInAppFrame(at('Job.save')));
    expect(topInAppFrame('Error: x\n    at /app/lib/Job.js:3:9')).to.eq('<anonymous> (Job.js)');
    expect(topInAppFrame('Error: x\n    at emit (node:events:518:28)\n    at internal/main.js:1:1')).to.eq(null);
    expect(topInAppFrame('Error: x\n    at async Job.run (file:///app/lib/Job.js:3:9)')).to.eq('Job.run (Job.js)');
  });
});
