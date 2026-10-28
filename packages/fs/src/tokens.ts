import { token } from '@spinajs/di';
import type { fs } from './interfaces.js';

/** Resolve with `[providerName]` to get the configured provider of that name. */
export const FILE_PROVIDER = token<fs>('__file_provider__');
