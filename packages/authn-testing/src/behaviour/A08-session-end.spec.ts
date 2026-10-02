import { defineRule } from './types.js';
import type { AuthnRule } from './types.js';

export const A08: AuthnRule = defineRule('A08', 'sessions end by timeout, logout and revocation', []);
