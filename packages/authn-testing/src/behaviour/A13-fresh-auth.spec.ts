import { defineRule } from './types.js';
import type { AuthnRule } from './types.js';

export const A13: AuthnRule = defineRule('A13', 'sensitive actions need fresh authentication', []);
