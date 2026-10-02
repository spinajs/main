import { defineRule } from './types.js';
import type { AuthnRule } from './types.js';

export const A10: AuthnRule = defineRule('A10', 'MFA codes are throttled, single use and kept secret', []);
