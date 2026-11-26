import { expect } from 'chai';
import { createProgramFromTsconfig, createContext, extractControllers } from '../../src/index.js';

describe('the fields option of @Access', () => {
  const unit = createProgramFromTsconfig('test/fixtures/unit/tsconfig.json');
  const ctx = createContext(unit, 'unit', 'test/fixtures/unit');
  const controllerIn = (file: string) => extractControllers(ctx, unit.sourceFiles.find((f) => f.fileName.endsWith(file))!)[0];
  const routes = [...controllerIn('access-fields.ts').routes, ...controllerIn('access-fields-shorthand.ts').routes];
  const filtered = (handler: string): boolean => routes.find((r) => r.handler === handler)!.middlewares.some((m) => m.type === 'AuthzFieldsMiddleware');

  it('records the fields middleware for a value the build cannot read', () => {
    expect(filtered('unreadable')).to.equal(true);
  });

  it('reads a constant, a shorthand constant and the literal none', () => {
    expect([filtered('constant'), filtered('shorthand'), filtered('shorthandNone'), filtered('none'), filtered('plain')]).to.deep.equal([true, true, false, false, false]);
  });

  it('counts options that may set fields where the build cannot read them as filtering', () => {
    expect([filtered('variable'), filtered('spread'), filtered('spreadAfterNone'), filtered('computedKey')]).to.deep.equal([true, true, true, true]);
  });

  it('does not count an unreadable member that cannot set fields', () => {
    expect([filtered('noneAfterSpread'), filtered('resourceNone')]).to.deep.equal([false, false]);
  });
});
