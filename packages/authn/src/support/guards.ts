import { isNonEmptyString, isPlainObject } from '@spinajs/util';

import type { IdentityRef } from '../contracts/credentials.js';

export const isRef = (v: unknown): v is IdentityRef => isPlainObject(v) && isNonEmptyString(v.type) && isNonEmptyString(v.id);
