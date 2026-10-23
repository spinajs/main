import { BasePath } from '@spinajs/http';

import { UploadController } from '../../../src/http/index.js';

/** A subclass without authorize, as only JavaScript can declare one; mount.test.ts checks that it fails closed. */
@BasePath('unguarded/uploads')
// @ts-expect-error authorize is abstract, so TypeScript refuses this class.
export class UnguardedUploadController extends UploadController {}
