import 'mocha';
import sinon from 'sinon';

import { DefaultQueueService } from '@spinajs/queue';
import { runBehaviour } from '@spinajs/authz-testing';

import { UserController } from '../../src/controllers/UserController.js';
import { usersHttpHarness } from '../support/behaviour-harness.js';

// B17.users is the C2 part of B17: GET /user answers the identity record through the output field filter.
describe('users-http v3: behaviour fixtures', function () {
  this.timeout(120000);

  before(() => {
    sinon.stub(DefaultQueueService.prototype, 'emit').resolves(undefined);
  });

  after(() => {
    sinon.restore();
  });

  runBehaviour(['B17.users'], () => usersHttpHarness([UserController]), { strict: true });
});
