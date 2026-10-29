import 'mocha';
import { expect } from 'chai';
import { modelsWithoutAccessResource } from '../../src/doctor/rules/models-without-access-resource.js';
import { fixture, controller, route, src } from './fixture.js';

const ctx = { cwd: '/fixture', fileExists: () => true, fragmentMtime: () => undefined, libMtime: () => undefined };
const invoice = { id: 'app:Invoice', className: 'Invoice', tableName: 'invoices', columns: [], relations: [], accessResource: false, source: src('src/invoice.ts') };

describe('ORM001 models-without-access-resource', () => {
  it('reports FromDbModel params whose model is not an access resource', () => {
    const m = fixture({
      models: [invoice, { ...invoice, id: 'app:User', className: 'User', tableName: 'users', accessResource: true, source: src('src/user.ts') }],
      controllers: [controller({ className: 'Invoices', routes: [
        route({ handler: 'get', params: [{ index: 0, name: 'invoice', kind: 'FromDbModel', runtimeType: { text: 'Invoice' }, required: true }], source: src('src/invoices.ts', 20) }),
        route({ handler: 'owner', params: [{ index: 0, name: 'user', kind: 'FromDbModel', runtimeType: { text: 'User' }, required: true }] }),
        route({ handler: 'body', params: [{ index: 0, name: 'dto', kind: 'FromBody', runtimeType: { text: 'Invoice' }, required: true }] }),
      ] })],
    });
    expect(modelsWithoutAccessResource.run(m, ctx)).to.deep.equal([
      { code: 'ORM001', severity: 'warning', message: 'Invoice is loaded by Invoices.get (FromDbModel) but is not an @AccessResource', source: src('src/invoices.ts', 20) },
    ]);
  });

  it('unwraps array types', () => {
    const m = fixture({
      models: [invoice],
      controllers: [controller({ className: 'Invoices', routes: [
        route({ handler: 'many', params: [{ index: 0, name: 'all', kind: 'FromDbModel', runtimeType: { text: 'Array<Invoice>' }, required: true }] }),
      ] })],
    });
    expect(modelsWithoutAccessResource.run(m, ctx)).to.have.length(1);
  });
});
