import { defineRule } from './types.js';
import type { AuthnRule } from './types.js';

export const A11: AuthnRule = defineRule('A11', 'single-use secrets are strong, hashed, bound, short-lived and opaque', []);
