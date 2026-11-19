import { expect } from 'chai';
import { testHost } from '@spinajs/authz-testing';
import { InternalLogger } from '@spinajs/internal-logger';

import { requireSystemPrincipal, resetSystemPrincipal, setBootWait } from '../src/system.js';
import { bootDb, DbHandle } from './support/db.js';

describe('configuration-db-source when the root AuthzService refuses to boot', function () {
  this.timeout(10000);

  const warn = InternalLogger.warn.bind(InternalLogger);
  const error = InternalLogger.error.bind(InternalLogger);
  const lines: { level: string; message: string }[] = [];
  let db: DbHandle;

  before(async () => {
    await testHost.installHost();
    db = await bootDb((path, value) => testHost.config().set([...path], value));
    await db.seed([{ path: 'app.title', value: 'T' }]);
    requireSystemPrincipal();
    setBootWait(20);
    testHost.config().set(['authz', 'models'], ['NoSuchModel']);

    const record = (level: string) => (fields: unknown, message: unknown) => {
      lines.push({ level, message: typeof fields === 'string' ? fields : String(message) });
    };
    InternalLogger.warn = record('warn') as typeof InternalLogger.warn;
    InternalLogger.error = record('error') as typeof InternalLogger.error;
  });

  after(async () => {
    InternalLogger.warn = warn;
    InternalLogger.error = error;
    setBootWait(15_000);
    resetSystemPrincipal();
    await db.dispose();
    await testHost.uninstallHost();
  });

  it('logs the refusal once over two polls, then recovers on the poll after the cause is fixed', async () => {
    await db.poll();
    await db.poll();

    expect(db.value('app.title')).to.equal(undefined);
    expect(lines.filter((l) => l.message.includes('booting it for the configuration source'))).to.have.length(1);
    expect(lines.filter((l) => l.message.includes('refused to boot for the configuration source'))).to.have.length(1);
    expect(lines.filter((l) => l.message.includes('Failed to refresh watched config values'))).to.have.length(0);

    testHost.config().set(['authz', 'models'], ['OtherMissingModel']);
    await db.poll();

    expect(lines.filter((l) => l.message.includes('refused to boot for the configuration source'))).to.have.length(2);

    testHost.config().unset(['authz', 'models']);
    await db.poll();

    expect(db.value('app.title')).to.equal('T');
  });
});
