import 'mocha';
import { expect } from 'chai';
import { createContext, createProgramFromTsconfig, extractControllers } from '../../src/index.js';

describe('@Idempotent', () => {
  const unit = createProgramFromTsconfig('test/fixtures/unit/tsconfig.json');
  const ctx = createContext(unit, 'unit', 'test/fixtures/unit');
  const extract = (name: string) => extractControllers(ctx, unit.sourceFiles.find((f) => f.fileName.endsWith(name))!);

  it('records required from a literal option, found through an import alias', () => {
    const [orders] = extract('idempotent-marker.ts');
    expect(orders.routes.find((r) => r.handler === 'create')!.idempotency).to.deep.equal({ required: true });
  });

  it('records required false without options and for options that are not a literal', () => {
    const [orders] = extract('idempotent-marker.ts');
    expect(orders.routes.find((r) => r.handler === 'draft')!.idempotency).to.deep.equal({ required: false });
    expect(orders.routes.find((r) => r.handler === 'chosen')!.idempotency).to.deep.equal({ required: false });
  });

  it('takes the top one of stacked decorators, as the runtime does', () => {
    const [orders] = extract('idempotent-marker.ts');
    expect(orders.routes.find((r) => r.handler === 'stacked')!.idempotency).to.deep.equal({ required: true });
  });

  it('reports options that are not a literal once', () => {
    const before = ctx.diagnostics.length;
    extract('idempotent-marker.ts');
    const reported = ctx.diagnostics.slice(before).filter((d) => d.code === 'CMP001');
    expect(reported.map((d) => d.message)).to.deep.equal(['non-literal decorator argument: chosenOptions()']);
  });

  it('leaves a route without it unmarked', () => {
    const [orders] = extract('idempotent-marker.ts');
    expect(orders.routes.find((r) => r.handler === 'plain')).to.not.have.property('idempotency');
  });

  it('ignores an Idempotent that does not resolve to @spinajs/http', () => {
    const [fake] = extract('idempotent-lookalike.ts');
    expect(fake.routes[0]).to.not.have.property('idempotency');
    expect(fake.routes[0].middlewares).to.deep.equal([]);
  });
});
