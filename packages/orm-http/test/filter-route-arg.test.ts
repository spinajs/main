import 'mocha';
import { expect } from 'chai';
import { InvalidArgument } from '@spinajs/exceptions';
// Declares IModelDescriptor.FilterableColumns, which model.ts reads.
import '../src/extension.js';
import { FilterModelRouteArg } from '../src/route-arg.js';

/**
 * Driven through `extract` on a prototype-only instance: a malformed filter fails at JSON.parse, before any
 * injected state is touched.
 */
describe('FilterModelRouteArg with a filter that is not valid JSON', () => {
  const self = Object.create(FilterModelRouteArg.prototype) as FilterModelRouteArg;
  const param = { Name: 'filter', Options: [{ column: 'Name', operators: ['eq'] }] } as any;

  async function failure(filter: string): Promise<InvalidArgument> {
    try {
      await self.extract({ Payload: {} } as any, [], param, { query: { filter }, body: {} } as any, {} as any, {} as any);
    } catch (err) {
      return err as InvalidArgument;
    }
    throw new Error('extract accepted the filter');
  }

  it('answers InvalidArgument without the parser text', async () => {
    const err = await failure('{"op":"and","filters":[{"Column":"Name","Operator":"eq","Value":Zq7filterTok}]}');

    expect(err).to.be.instanceOf(InvalidArgument);
    expect(err.message).to.eq("Filter parameter 'filter' is invalid JSON");
    for (const text of [err.message, JSON.stringify(err), JSON.stringify({ ...err }), String(err.stack)]) {
      expect(text).to.not.contain('Zq7filterTok');
    }
  });

  it('names the parameter as the field and keeps no inner error', async () => {
    const err = await failure('{"Value":Zq7filterTok');

    expect(err.fieldName).to.eq('filter');
    expect((err as any).inner).to.eq(undefined);
  });
});
