import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { ORM_CONFIGURATION_SCHEMA } from '../src/configuration-schema.js';
import * as schemaModule from '../src/configuration-schema.js';

describe('orm configuration schema registration', () => {
  it('is registered at import without a bootstrapper', () => {
    expect(DI.get(Array.ofType('__configurationSchema__'))).to.include(ORM_CONFIGURATION_SCHEMA);
    expect((schemaModule as Record<string, unknown>).OrmConfigurationBootstrapper).to.be.undefined;
  });
});
