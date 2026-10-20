import { isNonEmptyString, isPlainObject } from '@spinajs/util';

import type { IdentityRef } from '../contracts/credentials.js';

export const isRef = (v: unknown): v is IdentityRef => isPlainObject(v) && isNonEmptyString(v.type) && isNonEmptyString(v.id);

// The class only: a message may echo the credential that made the strategy throw.
export const errorClass = (err: unknown): string => (err instanceof Error && isNonEmptyString(err.name) ? err.name : typeof err);
