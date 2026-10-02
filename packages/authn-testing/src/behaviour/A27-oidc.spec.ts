import { defineRule } from './types.js';
import type { AuthnRule } from './types.js';

export const A27: AuthnRule = defineRule('A27', 'OIDC login is code flow with PKCE and full ID token checks', []);
