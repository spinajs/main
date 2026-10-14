import 'mocha';
import { expect } from 'chai';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { isAccessResourceClass, primaryKeyOf } from '../src/access-resource.js';

const MODELS = join(fileURLToPath(new URL('./fixtures', import.meta.url)), 'models.ts');

describe('isAccessResourceClass', function () {
  let checker: ts.TypeChecker;
  let exported: ts.Symbol[];

  before(() => {
    const program = ts.createProgram({ rootNames: [MODELS], options: { experimentalDecorators: true, strict: true, noEmit: true, types: [] } });
    checker = program.getTypeChecker();
    exported = checker.getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(MODELS)!)!);
  });

  const is = (name: string, extra: string[] = []) => isAccessResourceClass(exported.find((s) => s.name === name), checker, new Set(extra), new Map());

  it('accepts a class decorated with @AccessResource', () => {
    expect(is('Task')).to.eq(true);
  });

  it('accepts a subclass of one', () => {
    expect(is('SubTask')).to.eq(true);
  });

  it('refuses plain classes, other values and no symbol', () => {
    expect(is('Note')).to.eq(false);
    expect(is('Model')).to.eq(false);
    expect(is('models')).to.eq(false);
    expect(isAccessResourceClass(undefined, checker, new Set(), new Map())).to.eq(false);
  });

  it('accepts a class named in the extra set', () => {
    expect(is('Note', ['Note'])).to.eq(true);
  });

  it('finds the @Primary() property of a class or its base, and nothing without one', () => {
    const pk = (name: string) => primaryKeyOf(exported.find((s) => s.name === name), checker);
    expect(pk('Task')).to.eq('id');
    expect(pk('SubTask')).to.eq('id');
    expect(pk('Note')).to.eq(undefined);
    expect(primaryKeyOf(undefined, checker)).to.eq(undefined);
  });
});
