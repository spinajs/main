import * as chai from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';

import { AUTHN_CONFIGURATION_SCHEMA, LogAuthnAuditSink } from '../../src/index.js';
import type { AuditLog } from '../../src/index.js';
import { configurationOf } from '../behaviour/harness.js';

const expect = chai.expect;

describe('LogAuthnAuditSink hashIdentifiers set past the schema', function () {
  this.timeout(15000);

  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  it('hashes the identifiers for any value but false', async () => {
    for (const value of [undefined, null, 0, '', 'false']) {
      const child = DI.RootContainer.child();
      children.push(child);
      child.register(AUTHN_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
      child.register(configurationOf({ authn: { audit: { hashKey: { secret: 'k'.repeat(40) } } } }, undefined, true)).as(Configuration);
      const configuration = await child.resolve(Configuration);
      const sink = await child.resolve(LogAuthnAuditSink);
      const lines: string[] = [];
      const out: AuditLog = { info: (m) => lines.push(m), warn: (m) => lines.push(m) };
      (sink as unknown as { out: AuditLog }).out = out;

      configuration.set('authn.audit.hashIdentifiers', value);
      await sink.publish({ type: 'login', outcome: 'success', at: new Date(), identity: { type: 'user', id: 'u-42' }, ip: '198.51.100.23' });
      expect(lines[0], String(value)).to.not.contain('u-42').and.not.contain('198.51.100.23');
    }
  });

});
