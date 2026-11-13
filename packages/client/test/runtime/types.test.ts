import 'mocha';
import { expect } from 'chai';
import { typecheck } from '../support/typecheck.js';

const header = [
  `import { dateCodec, fromClass, type FormatCodecs, type FormatTypes, type ModelEntry, type ObjectPlanOf } from '@spinajs/client/runtime';`,
  `type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;`,
  '',
].join('\n');

describe('runtime model types', function () {
  this.timeout(120_000);

  it('types a codec slot passed as a literal as the codec value', () => {
    const source = `${header}const date: Eq<FormatTypes<{ 'date-time': typeof dateCodec }>['date-time'], Date> = true;\nconst text: Eq<FormatTypes<{ 'date-time': typeof dateCodec }>['date'], string> = true;\nexport { date, text };\n`;
    expect(typecheck(source)).to.deep.equal([]);
  });

  it('types every slot of no codecs as wire text', () => {
    const source = `${header}const date: Eq<FormatTypes<{}>['date-time'], string> = true;\nexport { date };\n`;
    expect(typecheck(source)).to.deep.equal([]);
  });

  it('types a slot of a widened FormatCodecs variable as exactly unknown', () => {
    const source = `${header}const formats: FormatCodecs = { 'date-time': dateCodec };\nconst value: Eq<FormatTypes<typeof formats>['date-time'], unknown> = true;\nexport { value };\n`;
    expect(typecheck(source)).to.deep.equal([]);
  });

  it('types an optional codec slot as the codec value or the wire text', () => {
    const source = `${header}const slot: Eq<FormatTypes<{ 'date-time'?: typeof dateCodec }>['date-time'], Date | string> = true;\nexport { slot };\n`;
    expect(typecheck(source)).to.deep.equal([]);
  });

  // The shape FG-18 emits: without the `= {}` default, an omitted `formats` infers F as FormatCodecs and every slot is unknown.
  it('keeps wire text for a models-only call of an overload whose codec parameter defaults to {}', () => {
    const source = [
      header,
      `declare function make<const F extends FormatCodecs = {}, const M extends Record<string, ModelEntry<unknown>> = {}>(options: { formats?: F; models?: M }): FormatTypes<F>;`,
      `declare function makeWithoutDefault<const F extends FormatCodecs, const M extends Record<string, ModelEntry<unknown>> = {}>(options: { formats?: F; models?: M }): FormatTypes<F>;`,
      `class User { id = 0 }`,
      `const modelsOnly = make({ models: { UserDto: fromClass(User) } });`,
      `const withCodec = make({ formats: { 'date-time': dateCodec }, models: { UserDto: fromClass(User) } });`,
      `const withoutDefault = makeWithoutDefault({ models: { UserDto: fromClass(User) } });`,
      `const a: Eq<(typeof modelsOnly)['date-time'], string> = true;`,
      `const b: Eq<(typeof withCodec)['date-time'], Date> = true;`,
      `const c: Eq<(typeof withoutDefault)['date-time'], unknown> = true;`,
      `export { a, b, c };`,
      '',
    ].join('\n');
    expect(typecheck(source)).to.deep.equal([]);
  });

  it('ObjectPlanOf rejects a plan that leaves out a declared property', () => {
    const source = `${header}interface ArticleDto { id: number; title?: string; publishedAt: string }\nexport const plan = { kind: 'object', closed: true, props: { publishedAt: { kind: 'format', format: 'date-time' } } } satisfies ObjectPlanOf<ArticleDto>;\n`;
    expect(typecheck(source).join('\n')).to.match(/missing the following properties.*id, title|'id'/);
  });

  it('ObjectPlanOf rejects a property the schema does not declare', () => {
    const source = `${header}interface ArticleDto { id: number }\nexport const plan = { kind: 'object', closed: true, props: { id: null, extra: null } } satisfies ObjectPlanOf<ArticleDto>;\n`;
    expect(typecheck(source).join('\n')).to.match(/'extra' does not exist/);
  });

  it('ObjectPlanOf accepts a plan that lists every declared property', () => {
    const source = `${header}interface ArticleDto { id: number; title?: string; publishedAt: string }\nexport const plan = { kind: 'object', closed: true, props: { id: null, title: null, publishedAt: { kind: 'format', format: 'date-time' } } } satisfies ObjectPlanOf<ArticleDto>;\n`;
    expect(typecheck(source)).to.deep.equal([]);
  });
});
