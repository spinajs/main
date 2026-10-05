import 'mocha';

import { BEHAVIOUR_FIXTURES, runBehaviour } from '@spinajs/authz-testing';

import { fsHarness } from './support/fs-harness.js';
import { FS_PROVIDER_KINDS, forEachKind } from './support/kinds.js';
import { fixturesOnS3, pendingOnS3 } from './support/on-s3.js';

// Release gate item 4: B28 on local, temp and S3.
forEachKind(FS_PROVIDER_KINDS, (kind) => {
  const s3 = kind === 's3';
  runBehaviour(['B02.adapter', 'B28', 'B29.fs'], () => fsHarness({ kind }), { strict: true, timeoutMs: 30000, fixtures: s3 ? fixturesOnS3(BEHAVIOUR_FIXTURES) : BEHAVIOUR_FIXTURES });
  if (s3) pendingOnS3(['B28.fs']);
});
