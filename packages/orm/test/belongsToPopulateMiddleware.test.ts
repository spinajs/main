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

/** The relation query of a belongsTo populate: every relation populated on it registers its middlewares on it. */
function relationQueryWith(middlewares: any[], nestedCount: number) {
  return { Middlewares: middlewares, Relations: Array.from({ length: nestedCount }, () => ({})) } as any;
}

describe('BelongsToPopulateDataMiddleware.afterHydration', () => {
  const description = { Name: 'Owner' } as any;

  it('runs each nested middleware exactly once with one nested relation', async () => {
    const log: string[] = [];
    const relationQuery = relationQueryWith([spyMiddleware('a', log)], 1);

    await new BelongsToPopulateDataMiddleware(description, relationQuery).afterHydration([{ Owner: { Value: null } } as any]);

    expect(log).to.deep.equal(['a']);
  });

  it('runs each nested middleware exactly once with two nested relations', async () => {
    const log: string[] = [];
    const relationQuery = relationQueryWith([spyMiddleware('a', log), spyMiddleware('b', log)], 2);

    await new BelongsToPopulateDataMiddleware(description, relationQuery).afterHydration([{ Owner: { Value: null } } as any]);

    expect(log).to.deep.equal(['a', 'b']);
  });

  it('runs two distinct middlewares that share a relation name', async () => {
    const log: string[] = [];
    const relationQuery = relationQueryWith([spyMiddleware('same', log), spyMiddleware('same', log)], 1);

    await new BelongsToPopulateDataMiddleware(description, relationQuery).afterHydration([{ Owner: { Value: null } } as any]);

    expect(log).to.deep.equal(['same', 'same']);
  });

  it('does not throw on a middleware without a _description', async () => {
    const log: string[] = [];
    const relationQuery = relationQueryWith([anonymousMiddleware(log)], 2);

    await new BelongsToPopulateDataMiddleware(description, relationQuery).afterHydration([{ Owner: { Value: null } } as any]);

    expect(log).to.deep.equal(['anonymous']);
  });

  it('runs nothing when no relation is populated on the relation query', async () => {
    const log: string[] = [];
    const relationQuery = relationQueryWith([spyMiddleware('a', log)], 0);

    await new BelongsToPopulateDataMiddleware(description, relationQuery).afterHydration([{ Owner: { Value: null } } as any]);

    expect(log).to.deep.equal([]);
  });

  it('runs a middleware registered twice once', async () => {
    const log: string[] = [];
    const twice = spyMiddleware('a', log);
    const relationQuery = relationQueryWith([twice, twice], 1);

    await new BelongsToPopulateDataMiddleware(description, relationQuery).afterHydration([{ Owner: { Value: null } } as any]);

    expect(log).to.deep.equal(['a']);
  });

  it('passes only non-null relation values downstream', async () => {
    const seen: any[] = [];
    const relationQuery = relationQueryWith(
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
    await new BelongsToPopulateDataMiddleware(description, relationQuery).afterHydration(rows);

    expect(seen).to.deep.equal([{ id: 1 }]);
  });
});
