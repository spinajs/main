import 'mocha';
import { expect } from 'chai';

import { AuthzFieldTransformer, AuthzFieldsMiddleware } from '../src/index.js';

// The reading rule of docs/http/14-route-middlewares.md, as @spinajs/cache-http applies it to a mounted class.
function perPrincipal(type: object): boolean {
  return 'PerPrincipalReply' in type && type.PerPrincipalReply === true;
}

describe('AuthzFieldsMiddleware and response caches', () => {
  for (const type of [AuthzFieldsMiddleware, AuthzFieldTransformer]) {
    it(`${type.name} declares that a reply it filtered belongs to the caller it was filtered for`, () => {
      const marker: true = type.PerPrincipalReply;
      expect(marker).to.equal(true);
      expect(Object.getOwnPropertyDescriptor(type, 'PerPrincipalReply')?.value).to.equal(true);
      const instance = new type();
      expect(instance).to.not.have.property('PerPrincipalReply');
      expect(perPrincipal(type)).to.equal(true);
      expect(perPrincipal(instance.constructor)).to.equal(true);
    });
  }

  it('is inherited by a subclass, and a subclass cannot redeclare it as false', () => {
    class AppFields extends AuthzFieldsMiddleware {}
    // @ts-expect-error TS2417: the literal type `true` of the base makes `false` incompatible
    class Unmarked extends AuthzFieldsMiddleware {
      public static override readonly PerPrincipalReply = false;
    }

    expect(AppFields.PerPrincipalReply).to.equal(true);
    expect(perPrincipal(AppFields)).to.equal(true);
    expect(perPrincipal(Unmarked)).to.equal(false);
  });

  it('counts only the strict value true', () => {
    class Missing {}
    class Text {
      public static readonly PerPrincipalReply = 'true';
    }
    class One {
      public static readonly PerPrincipalReply = 1;
    }
    class OnInstance {
      public readonly PerPrincipalReply = true;
    }

    for (const type of [Missing, Text, One, OnInstance]) expect(perPrincipal(type), type.name).to.equal(false);
  });
});
