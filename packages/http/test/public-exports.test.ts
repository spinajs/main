import 'mocha';
import { expect } from 'chai';
import * as http from '../src/index.js';

describe('the @spinajs/http root', () => {
  it('does not export the helpers only this package calls', () => {
    for (const name of ['parseForm', 'describes', 'routeEntryOf', 'capturedJsonReply', 'responseCaptureOf', 'createAroundHandler', 'recordRouteError', 'wrapsRoute', 'enterMiddleware', 'beginRoute', 'answerEarly', 'setErrorReply', 'routeContextOf']) expect(http, name).to.not.have.property(name);
  });

  it('does not export the handlers and helpers that drive the pipeline state of a request', () => {
    for (const name of [
      'createBeforeHandler',
      'createEntryHandler',
      'serverMiddlewareHandlers',
      'refuseRemovedHooks',
      'globalErrorReplier',
      'serverContextOf',
      'createServerAroundHandler',
      'answeredErrorOf',
      'globalRouteMiddlewareDescriptors',
    ])
      expect(http, name).to.not.have.property(name);
  });

  it('exports the around middleware API', () => {
    for (const name of ['RouteMiddleware', 'RouteClientGone', 'buildRouteHandlers', 'IdempotencyMiddleware']) expect(http, name).to.have.property(name);
  });

  it('exports the middleware base class, the reply pipeline and the named @Accepts middleware', () => {
    for (const name of ['HttpMiddleware', 'sendReply', 'AcceptsMiddleware']) expect(http, name).to.have.property(name);
    expect(Object.getPrototypeOf(http.RouteMiddleware)).to.eq(http.HttpMiddleware);
  });

  it('exports the server middleware base on the same base class, and the Responses middlewares answer with', () => {
    expect(Object.getPrototypeOf(http.ServerMiddleware)).to.eq(http.HttpMiddleware);
    for (const name of ['RawJsonResponse', 'ReplayedResponse']) expect(http, name).to.have.property(name);
  });
});
