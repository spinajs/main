import 'mocha';
import { expect } from 'chai';
import { Constructor } from '@spinajs/di';
import { BadRequest, Forbidden } from '@spinajs/exceptions';

import { __resolve_error_response__ } from '../src/error.js';
import { Response as HttpResponse } from '../src/interfaces.js';
import { ForbiddenResponse } from '../src/response-methods/forbidden.js';
import { BadRequestResponse } from '../src/response-methods/badRequest.js';

/**
 * `@HandleException` keys the map by class NAME, so an exception the framework knows by name is an
 * exact hit. A feature that subclasses one of those to say WHICH rule refused the request
 * ( `class GroupNotOwned extends Forbidden` ) must land on the same response - otherwise a fully
 * understood 403 is answered as a 500.
 */
class GroupNotOwned extends Forbidden {}
class DeeperStillNotOwned extends GroupNotOwned {}
class NotAnHttpError extends Error {}

describe('http error map resolution', () => {
  const map = new Map<string, Constructor<HttpResponse>>([
    ['Forbidden', ForbiddenResponse as unknown as Constructor<HttpResponse>],
    ['BadRequest', BadRequestResponse as unknown as Constructor<HttpResponse>],
  ]);

  it('answers the exact registration for a mapped exception', () => {
    expect(__resolve_error_response__(map, new Forbidden('nope'))).to.equal(map.get('Forbidden'));
  });

  it('answers the base class registration for a domain subclass', () => {
    expect(__resolve_error_response__(map, new GroupNotOwned('user 1 does not own group 2'))).to.equal(map.get('Forbidden'));
  });

  it('walks more than one level up', () => {
    expect(__resolve_error_response__(map, new DeeperStillNotOwned('still no'))).to.equal(map.get('Forbidden'));
  });

  it('prefers an exact registration over the inherited one', () => {
    const withExact = new Map(map);
    withExact.set('GroupNotOwned', BadRequestResponse as unknown as Constructor<HttpResponse>);

    expect(__resolve_error_response__(withExact, new GroupNotOwned('nope'))).to.equal(withExact.get('GroupNotOwned'));
  });

  it('answers null for an exception with nothing mapped in its chain', () => {
    expect(__resolve_error_response__(map, new NotAnHttpError('boom'))).to.be.null;
  });

  it('answers null rather than throwing for a non-error value', () => {
    expect(__resolve_error_response__(map, undefined)).to.be.null;
    expect(__resolve_error_response__(map, null)).to.be.null;
  });

  it('does not fall back to a registration made for a plain BadRequest sibling', () => {
    // Forbidden and BadRequest are siblings, not a chain - a Forbidden must never resolve to the
    // BadRequest response just because both are registered.
    expect(__resolve_error_response__(map, new BadRequest('bad'))).to.equal(map.get('BadRequest'));
  });
});
