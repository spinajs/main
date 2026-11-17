import 'mocha';
import { expect } from 'chai';
import { createContext, createProgramFromTsconfig, extractControllers } from '../../src/index.js';

describe('stacked @Idempotent', () => {
  const unit = createProgramFromTsconfig('test/fixtures/unit/tsconfig.json');
  const ctx = createContext(unit, 'unit', 'test/fixtures/unit');
  const [controller] = extractControllers(ctx, unit.sourceFiles.find((f) => f.fileName.endsWith('stacked-idempotent.ts'))!);

  // The runtime mounts [IdempotencyMiddleware (ttl 2h), Second, First] (http/test/idempotent-decorator.test.ts);
  // the manifest lists a method's middlewares in source order, the reverse.
  it('records one gate, with the arguments of the top decorator, at the place of the bottom one', () => {
    expect(controller.routes.find((r) => r.handler === 'mixed')!.middlewares).to.deep.equal([
      { type: 'First', options: [] },
      { type: 'Second', options: [] },
      { type: 'IdempotencyMiddleware', decoratorArgs: [{ ttl: '2h' }] },
    ]);
  });
});
