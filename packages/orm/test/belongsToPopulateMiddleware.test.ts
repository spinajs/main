/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from 'chai';
import 'mocha';
import { BelongsToPopulateDataMiddleware } from '../src/middlewares.js';

/** A middleware that records how many times its afterHydration ran. */
function spyMiddleware(name: string, log: string[]) {
  return {
    _description: { Name: name },
    afterQuery: (d: any[]) => d,
    modelCreation: () => null,
    afterHydration: async () => {
      log.push(name);
    },
  };
}

/** A middleware with no `_description`, like BelongsToRelationResultTransformMiddleware. */
function anonymousMiddleware(log: string[]) {
  return {
    afterQuery: (d: any[]) => d,
    modelCreation: () => null,
    afterHydration: async () => {
      log.push('anonymous');
    },
  };
}

/**
 * Builds the shape the real code walks: one relation query whose `_middlewares` array is
 * shared by every relation registered on it — which is precisely why the old reduce
 * duplicated.
 */
function relationWith(middlewares: any[], nestedCount: number) {
  const relationQuery = { _middlewares: middlewares };
  const relations = Array.from({ length: nestedCount }, () => ({ _query: relationQuery }));

  return { _relationQuery: { ...relationQuery, Relations: relations } } as any;
}

describe('BelongsToPopulateDataMiddleware.afterHydration', () => {
  const description = { Name: 'Owner' } as any;

  it('runs each nested middleware exactly once with one nested relation', async () => {
    const log: string[] = [];
    const relation = relationWith([spyMiddleware('a', log)], 1);

    await new BelongsToPopulateDataMiddleware(description, relation).afterHydration([{ Owner: { Value: null } } as any]);

    expect(log).to.deep.equal(['a']);
  });

  it('runs each nested middleware exactly once with two nested relations', async () => {
    const log: string[] = [];
    const relation = relationWith([spyMiddleware('a', log), spyMiddleware('b', log)], 2);

    await new BelongsToPopulateDataMiddleware(description, relation).afterHydration([{ Owner: { Value: null } } as any]);

    expect(log).to.deep.equal(['a', 'b']);
  });

  it('runs two distinct middlewares that share a relation name', async () => {
    const log: string[] = [];
    const relation = relationWith([spyMiddleware('same', log), spyMiddleware('same', log)], 1);

    await new BelongsToPopulateDataMiddleware(description, relation).afterHydration([{ Owner: { Value: null } } as any]);

    expect(log).to.deep.equal(['same', 'same']);
  });

  it('does not throw on a middleware without a _description', async () => {
    const log: string[] = [];
    const relation = relationWith([anonymousMiddleware(log)], 2);

    await new BelongsToPopulateDataMiddleware(description, relation).afterHydration([{ Owner: { Value: null } } as any]);

    expect(log).to.deep.equal(['anonymous']);
  });

  it('passes only non-null relation values downstream', async () => {
    const seen: any[] = [];
    const relation = relationWith(
      [
        {
          _description: { Name: 'a' },
          afterQuery: (d: any[]) => d,
          modelCreation: () => null,
          afterHydration: async (d: any[]) => {
            seen.push(...d);
          },
        },
      ],
      1,
    );

    const rows = [{ Owner: { Value: { id: 1 } } }, { Owner: { Value: null } }, { Owner: { Value: undefined } }] as any[];
    await new BelongsToPopulateDataMiddleware(description, relation).afterHydration(rows);

    expect(seen).to.deep.equal([{ id: 1 }]);
  });
});
