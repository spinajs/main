import 'mocha';
import { expect } from 'chai';
import * as http from '../src/index.js';

describe('the @spinajs/http root', () => {
  it('does not export the helpers only this package calls', () => {
    for (const name of ['parseForm', 'describes', 'routeEntryOf', 'capturedJsonReply', 'responseCaptureOf', 'createAroundHandler', 'recordRouteError', 'wrapsRoute']) expect(http, name).to.not.have.property(name);
  });

  it('exports the around middleware API', () => {
    for (const name of ['AroundMiddleware', 'RouteClientGone', 'buildRouteHandlers', 'IdempotencyMiddleware']) expect(http, name).to.have.property(name);
  });
});
