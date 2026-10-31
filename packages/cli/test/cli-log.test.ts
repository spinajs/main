import 'mocha';
import { expect } from 'chai';

import '@spinajs/log';
import { InternalLoggerProxy } from '@spinajs/internal-logger';
import { CommanderError } from 'commander';
import { fatalMessage, reportFatal, resolveCliLog } from '../src/cliLog.js';

describe('fatalMessage', () => {
  it('keeps what an error hides out of the output', () => {
    const driver = Object.assign(new Error('Duplicate entry'), { sql: 'INSERT INTO users VALUES (1)', code: 'ER_DUP_ENTRY' });
    expect(fatalMessage(new Error('Cannot run the query', { cause: driver }))).to.equal('Cannot run the query');
  });

  it('prints a thrown value that is no Error', () => {
    expect(fatalMessage('boom')).to.equal('boom');
  });
});

describe('reportFatal', () => {
  it('writes a failure to stderr', async () => {
    const lines: string[] = [];
    await reportFatal(new Error('boom'), (line) => lines.push(line));
    expect(lines).to.deep.equal(['boom']);
  });

  it('leaves a commander error to the writeErr that already printed it', async () => {
    const lines: string[] = [];
    await reportFatal(new CommanderError(1, 'commander.unknownOption', 'unknown option'), (line) => lines.push(line));
    expect(lines).to.deep.equal([]);
  });
});

describe('resolveCliLog', () => {
  it('falls back to InternalLoggerProxy when no Log implementation is registered', () => {
    const log = resolveCliLog(() => false);

    expect(log).to.be.instanceOf(InternalLoggerProxy);
    expect(() => log.success('welcome')).to.not.throw();
    expect(() => log.error('boom')).to.not.throw();
  });

  it('resolves the registered logger when an implementation is available', () => {
    // @spinajs/log is imported above, which registers the Log factory in DI
    const log = resolveCliLog();

    expect(log.success).to.be.a('function');
    expect(log.error).to.be.a('function');
  });
});
