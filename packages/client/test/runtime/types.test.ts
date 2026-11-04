import 'mocha';
import { expect } from 'chai';
import { typecheck } from '../support/typecheck.js';

const header = `import { dateCodec, type FormatCodecs, type FormatTypes, type ObjectPlanOf } from '@spinajs/client/runtime';\n`;

describe('runtime model types', function () {
  this.timeout(120_000);

  it('types a codec slot passed as a literal as the codec value', () => {
    const source = `${header}const date: FormatTypes<{ 'date-time': typeof dateCodec }>['date-time'] = new Date();\nconst text: FormatTypes<{ 'date-time': typeof dateCodec }>['date'] = '2026-05-01';\nexport { date, text };\n`;
    expect(typecheck(source)).to.deep.equal([]);
  });

  it('does not claim the wire type for a slot of a widened FormatCodecs variable', () => {
    const source = `${header}const formats: FormatCodecs = { 'date-time': dateCodec };\nconst value: FormatTypes<typeof formats>['date-time'] = new Date();\nexport { value };\n`;
    expect(typecheck(source)).to.deep.equal([]);
  });

  it('types an optional codec slot as the codec value or the wire text', () => {
    const source = `${header}type F = FormatTypes<{ 'date-time'?: typeof dateCodec }>;\nconst a: F['date-time'] = new Date();\nconst b: F['date-time'] = 'x';\nconst c: F['date-time'] = 1;\nexport { a, b, c };\n`;
    const errors = typecheck(source);
    expect(errors).to.have.length(1);
    expect(errors[0]).to.match(/'number' is not assignable/);
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
