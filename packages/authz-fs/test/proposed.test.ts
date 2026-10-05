import 'mocha';

import { BEHAVIOUR_FIXTURES, runBehaviour } from '@spinajs/authz-testing';

import { B02Adapter } from './proposed/B02-adapter.js';
import { B28Residual } from './proposed/B28-residual.js';
import { B28SignedUrl } from './proposed/B28-signed-url.js';
import { B29FsAbac } from './proposed/B29-fs-abac.js';
import { fsHarness } from './support/fs-harness.js';
import { FS_PROVIDER_KINDS, forEachKind } from './support/kinds.js';

// Cases L7 proposes to the kit (RFC L7-1); until then they run from here.
forEachKind(FS_PROVIDER_KINDS, (kind) => {
  runBehaviour(['B02.adapter', 'B28.residual', 'B28.signedUrl', 'B29.fs-abac'], () => fsHarness({ kind }), { strict: true, timeoutMs: 30000, fixtures: [...BEHAVIOUR_FIXTURES, B02Adapter, B28Residual, B28SignedUrl, B29FsAbac] });
});
