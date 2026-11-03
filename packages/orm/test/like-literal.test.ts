import { expect } from 'chai';
import 'mocha';
import { InvalidArgument } from '@spinajs/exceptions';

import { LikeLiteral } from '../src/statements.js';

describe('LikeLiteral', () => {
  it('wraps the escaped text in the wildcards of its match', () => {
    expect(LikeLiteral.contains('a').pattern('x~_')).to.eq('%x~_%');
    expect(LikeLiteral.startsWith('a').pattern('x~_')).to.eq('x~_%');
    expect(LikeLiteral.endsWith('a').pattern('x~_')).to.eq('%x~_');
  });

  it('matches by containment unless told otherwise', () => {
    expect(new LikeLiteral('a').Match).to.eq('contains');
  });

  it('recognises a literal built by a second loaded copy of the ORM', async () => {
    // The cjs and mjs builds can be loaded side by side; a query string loads a second copy of statements.ts.
    const copy: { LikeLiteral: typeof LikeLiteral } = await import(new URL('../src/statements.js?second-copy', import.meta.url).href);
    expect(copy.LikeLiteral).to.not.equal(LikeLiteral);

    const foreign = copy.LikeLiteral.contains('a');
    expect(foreign).to.not.be.instanceOf(LikeLiteral);
    expect(LikeLiteral.is(foreign)).to.eq(true);
  });

  it('tells a literal from a look-alike object and from a string', () => {
    expect(LikeLiteral.is({ Text: 'a', Match: 'contains' })).to.eq(false);
    expect(LikeLiteral.is('%a%')).to.eq(false);
    expect(LikeLiteral.is(null)).to.eq(false);
  });

  it('refuses text that is not a string', () => {
    expect(() => LikeLiteral.contains(null as unknown as string)).to.throw(InvalidArgument, 'LikeLiteral takes a string, got null');
    expect(() => LikeLiteral.contains(5 as unknown as string)).to.throw(InvalidArgument, 'LikeLiteral takes a string, got number');
  });
});
