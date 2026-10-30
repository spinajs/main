import { Constructor, token } from '@spinajs/di';
import type { Response } from './interfaces.js';

/** Response class by exception name, filled by `@HandleException`. */
export const HTTP_ERROR_MAP = token<Map<string, Constructor<Response>>>('__http_error_map__');
