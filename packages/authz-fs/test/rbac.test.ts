import 'mocha';

import { BEHAVIOUR_FIXTURES, runBehaviour } from '@spinajs/authz-testing';

import { B16Owner } from './proposed/B16-owner.js';
import { B16OwnerS3 } from './proposed/B16-owner-s3.js';
import { fsHarness } from './support/fs-harness.js';
import { FS_PROVIDER_KINDS, forEachKind } from './support/kinds.js';
import { fixturesOnS3, pendingOnS3 } from './support/on-s3.js';

// The fs grants of design §8.2 through the real RbacModel: the kit's B16.fs and the owner grant B16.fs left to L7.
forEachKind(FS_PROVIDER_KINDS, (kind) => {
  const s3 = kind === 's3';
  const fixtures = [...BEHAVIOUR_FIXTURES, B16Owner, B16OwnerS3];
  // B16.fs-owner-s3 needs fsS3: S3ObjectMetadataStore keeps the owners on the objects.
  runBehaviour(s3 ? ['B16.fs', 'B16.fs-owner', 'B16.fs-owner-s3'] : ['B16.fs', 'B16.fs-owner'],() => fsHarness({ kind, rbac: true }), { strict: true, timeoutMs: 30000, fixtures: s3 ? fixturesOnS3(fixtures) : fixtures });
  if (s3) pendingOnS3(['B16.fs-owner']);
});
