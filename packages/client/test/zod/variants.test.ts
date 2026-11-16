import 'mocha';
import { expect } from 'chai';
import { buildClientModel } from '../../src/index.js';
import { Diagnostics } from '../../src/generate/zod/diagnostics.js';
import { Printer } from '../../src/generate/zod/print.js';
import { SchemaGraph } from '../../src/generate/zod/refs.js';
import { ZodBuilder, type Variant } from '../../src/generate/zod/schema.js';
import { appBasicManifest } from '../support/fixture.js';
import { manifestWith } from '../support/zod.js';

const schema = {
  type: 'object',
  properties: { a: { type: 'string' } },
  patternProperties: { '^x': { type: 'number' } },
  additionalProperties: false,
  not: { required: ['b'] },
};

// FG-7 prints reply variants with the same builder; until then these are its only callers.
describe('ZodBuilder variants', () => {
  async function build(variant: Variant): Promise<{ code: string; hoisted: string[] }> {
    const model = buildClientModel(manifestWith(await appBasicManifest(), { Reply: schema }));
    const builder = new ZodBuilder(new SchemaGraph(model.ctx, [...model.ctx.used]), model.ctx, new Diagnostics('warning'));
    const code = new Printer(false).print(builder.root(schema, { at: { schema: 'test/Reply', pointer: '' }, variant }));
    return { code, hoisted: builder.takeHoisted().map((h) => h.name) };
  }

  it('a request refuses the keys patternProperties leaves to additionalProperties: false', async () => {
    const { code, hoisted } = await build('request');
    expect(code).to.include('additionalProperties(["a"], [new RegExp(');
    expect(hoisted.every((name) => name.startsWith('_check'))).to.equal(true);
  });

  it("a reply accepts them, and its not and if read the request schemas, hoisted as the request's", async () => {
    const { code, hoisted } = await build('reply');
    expect(code).to.not.include('additionalProperties(');
    expect(code).to.include('patternProperties(');
    expect(code).to.include("'must NOT be valid'");
    expect(hoisted.length).to.be.above(0);
    expect(hoisted.every((name) => name.startsWith('_check'))).to.equal(true);
  });
});
