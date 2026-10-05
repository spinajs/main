import 'mocha';
import { BEHAVIOUR_FIXTURES, runBehaviour } from '@spinajs/authz-testing';
import type { BehaviourFixture, FixtureExtension } from '@spinajs/authz-testing';

import { adminHttpHarness } from './support/admin-http.js';

// This case lists links through GET /authz/links, a link route that comes with task 4; until then it
// is filtered out of the catalogue here (the kit stays as it is).
const NEEDS_LINK_ROUTES = 'a link token appears only in the command result';

const fixtures = BEHAVIOUR_FIXTURES.map((f): BehaviourFixture | FixtureExtension =>
  f.id !== 'B43' ? f : { ...f, parts: f.parts.map((p) => (p.name !== 'http' ? p : { ...p, cases: p.cases.filter((c) => c.name !== NEEDS_LINK_ROUTES) })) },
);

// The first hook boots the app and loads authz-rbac's src through ts-node, which takes more than mocha's 2 s.
describe('authz-http-admin behaviour', function () {
  this.timeout(30000);
  runBehaviour(['B43.http', 'B12.http', 'B13.http', 'B26.http', 'B27.events'], () => adminHttpHarness(), { strict: true, fixtures });
});
