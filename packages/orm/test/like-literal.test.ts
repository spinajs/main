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

  it('refuses text that is not a string', () => {
    expect(() => LikeLiteral.contains(null as unknown as string)).to.throw(InvalidArgument, 'LikeLiteral takes a string, got null');
    expect(() => LikeLiteral.contains(5 as unknown as string)).to.throw(InvalidArgument, 'LikeLiteral takes a string, got number');
  });
});
