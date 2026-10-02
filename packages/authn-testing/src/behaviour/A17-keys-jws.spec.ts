import { defineRule } from './types.js';
import type { AuthnRule } from './types.js';

export const A17: AuthnRule = defineRule('A17', 'keys are Ed25519 or P-256 and JWS follows the C8 rules', []);
