import * as chai from 'chai';
import 'mocha';
import { SYSTEM, currentPrincipal } from '@spinajs/authz';
import { captureReadScope } from '@spinajs/orm';
import '../src/index.js';

const expect = chai.expect;

describe('SystemCaptureReadScope', () => {
  it('runs the capture key select as SYSTEM', async () => {
    expect(await captureReadScope().run(async () => currentPrincipal())).to.equal(SYSTEM);
  });
});
