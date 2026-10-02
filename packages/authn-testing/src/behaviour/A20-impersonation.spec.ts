import { defineRule } from './types.js';
import type { AuthnRule } from './types.js';

export const A20: AuthnRule = defineRule('A20', 'impersonation is guarded, rotated, bounded and audited', []);
