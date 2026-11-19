import 'mocha';
import * as chai from 'chai';
import { DI, IContainer } from '@spinajs/di';
import { Configuration, ConfigurationSource } from '@spinajs/configuration-common';
import { InternalLogger } from '@spinajs/internal-logger';

import { configurationOf, NoSource } from './fixtures.js';
import { InvalidConfiguration } from '../src/exception.js';

const expect = chai.expect;

const MAILER = {
  $id: 'test-mailer',
  $configurationModule: 'mailer',
  type: 'object',
  properties: { retries: { type: 'integer', maximum: 5 } },
};

class CapturingInternalLogger extends InternalLogger {
  public lines: string[] = [];
  public dumpedMessages: string[] = [];

  constructor() {
    super();
    const capture = (line: string) => this.lines.push(line);
    for (const level of Object.keys(this.StdConsoleCallbackMap)) Object.assign(this.StdConsoleCallbackMap, { [level]: capture });
  }

  protected dumpBuffer(): void {
    this.dumpedMessages.push(...InternalLogger.LogBuffer.map((entry) => String(entry.Variables.message)));
    super.dumpBuffer();
  }
}

describe('a refused configuration boot', () => {
  const logger = new CapturingInternalLogger();
  let exitDump: NodeJS.BeforeExitListener | undefined;
  let child: IContainer;

  before(() => {
    const listeners = process.listeners('beforeExit');
    logger.bootstrap();
    // Taken off the process so the test run does not print at exit; the test calls it itself.
    exitDump = process.listeners('beforeExit').find((l) => !listeners.includes(l));
    if (exitDump) process.off('beforeExit', exitDump);
  });

  after(async () => {
    await child.dispose();
  });

  it('prints its violations before the resolve rejects, and not again at exit', async () => {
    child = DI.child();
    child.register(MAILER).asValue('__configurationSchema__');
    child.register(NoSource).as(ConfigurationSource);
    child.register(configurationOf({ mailer: { retries: 99 } })).as(Configuration);

    let linesWhenRejected: string[] | undefined;
    let dumpedWhenRejected: string[] | undefined;
    try {
      await child.resolve(Configuration);
    } catch (e) {
      expect(e).to.be.instanceOf(InvalidConfiguration);
      // An app that calls process.exit() here never reaches beforeExit.
      linesWhenRejected = [...logger.lines];
      dumpedWhenRejected = [...logger.dumpedMessages];
    }

    if (linesWhenRejected === undefined || dumpedWhenRejected === undefined) throw new Error('the resolve did not reject');
    const violations = linesWhenRejected.filter((l) => l.includes('Invalid configuration at mailer.retries'));
    expect(violations).to.have.length(1);
    expect(violations[0]).to.include('test-mailer').and.include('must be <= 5');

    // A subclass that saves the leftovers elsewhere sees the violation through its dumpBuffer() override.
    expect(dumpedWhenRejected.filter((m) => m.includes('Invalid configuration at mailer.retries'))).to.have.length(1);

    expect(exitDump, 'bootstrap() registered no beforeExit listener').to.be.a('function');
    exitDump?.(0);
    expect(logger.lines).to.deep.equal(linesWhenRejected);
  });
});
