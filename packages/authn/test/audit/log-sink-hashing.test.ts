import * as chai from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Configuration, InvalidConfiguration } from '@spinajs/configuration';
import { Log } from '@spinajs/log-common';

import { AUTHN_CONFIGURATION_SCHEMA, LogAuthnAuditSink } from '../../src/index.js';
import { configurationOf } from '../behaviour/harness.js';
import { TestLog } from './test-log.js';

const expect = chai.expect;

describe('LogAuthnAuditSink hashIdentifiers set past the schema', function () {
  this.timeout(15000);

  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  it('hashes the identifiers for any value but false', async () => {
    for (const value of [undefined, null, 0, '', 'false']) {
      TestLog.clear();
      const child = DI.RootContainer.child();
      children.push(child);
      child.register(TestLog).as(Log as never);
      child.register(AUTHN_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
      child.register(configurationOf({ authn: { audit: { hashKey: { secret: 'k'.repeat(40) } } } }, undefined, true)).as(Configuration);
      const configuration = await child.resolve(Configuration);
      const sink = await child.resolve(LogAuthnAuditSink);

      configuration.set('authn.audit.hashIdentifiers', value);
      await sink.publish({ type: 'login', outcome: 'success', at: new Date(), identity: { type: 'user', id: 'u-42' }, ip: '198.51.100.23' });
      const [line] = TestLog.of('authn-audit').map((e) => e.message);
      expect(line, String(value)).to.match(/^authn audit login success /);
      expect(line, String(value)).to.not.contain('u-42').and.not.contain('198.51.100.23');
    }
  });

  it('is not coerced by the schema: a null, 0 or boolean string fails the boot', async () => {
    for (const value of [null, 0, 'false', 'true']) {
      const child = DI.RootContainer.child();
      children.push(child);
      child.register(AUTHN_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
      child.register(configurationOf({ authn: { audit: { hashIdentifiers: value } } }, undefined, true)).as(Configuration);
      const error = await child.resolve(Configuration).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error, String(value)).to.be.instanceOf(InvalidConfiguration);
      expect((error as InvalidConfiguration).violations.map((v) => v.path), String(value)).to.include('authn.audit.hashIdentifiers');
    }
  });
});
