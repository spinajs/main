import 'mocha';
import { expect } from 'chai';
import * as http from '../src/index.js';

describe('the @spinajs/http root', () => {
  it('does not export the helpers only this package calls', () => {
    for (const name of ['parseForm', 'describes', 'routeEntryOf', 'capturedJsonReply', 'responseCaptureOf', 'recordIdempotentRouteError']) expect(http, name).to.not.have.property(name);
  });
});
