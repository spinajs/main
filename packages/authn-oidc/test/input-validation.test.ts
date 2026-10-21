import 'mocha';
import { expect } from 'chai';
import { getRegisteredSchema } from '@spinajs/validation';
import { isValidField } from '@spinajs/authn';

import { BackchannelForm, OidcBeginQuery, OidcCallbackQueryDto, OidcUnlinkQuery, oidcProviderParam } from '../src/dto.js';

const ok = (schema: object, value: unknown): boolean => isValidField(schema, value);
const schemaOf = (type: { name: string }): object => getRegisteredSchema(type.name)!;

describe('OIDC route inputs (HARD-VAL3)', () => {
  it('every schema id starts with authn., so the validator checks it without coercion', () => {
    for (const type of [OidcBeginQuery, OidcCallbackQueryDto, OidcUnlinkQuery, BackchannelForm]) {
      expect((schemaOf(type) as { $id: string }).$id).to.match(/^authn\.oidc\./);
    }
    expect((oidcProviderParam as { $id: string }).$id).to.match(/^authn\.oidc\./);
  });

  it(':provider takes 1 to 64 of [A-Za-z0-9_-]', () => {
    for (const good of ['a', 'corp', 'my_idp-2', 'a'.repeat(64)]) expect(ok(oidcProviderParam, good), good).to.eq(true);
    for (const bad of ['', 'a'.repeat(65), 'co rp', 'co.rp', 'a/b', 'ł', 5]) expect(ok(oidcProviderParam, bad), String(bad)).to.eq(false);
  });

  it('the begin query allows returnTo up to 1024 and nothing else', () => {
    const s = schemaOf(OidcBeginQuery);
    expect(ok(s, {})).to.eq(true);
    expect(ok(s, { returnTo: 'a'.repeat(1024) })).to.eq(true);
    expect(ok(s, { returnTo: 'a'.repeat(1025) })).to.eq(false);
    expect(ok(s, { returnTo: ['a', 'b'] })).to.eq(false);
    expect(ok(s, { returnTo: '/', utm: '1' })).to.eq(false);
  });

  it('the callback query caps the keys the flow reads at 4096 and lets other keys through', () => {
    const s = schemaOf(OidcCallbackQueryDto);
    for (const k of ['code', 'state', 'iss', 'error', 'bounce']) {
      expect(ok(s, { [k]: 'a'.repeat(4096) }), k).to.eq(true);
      expect(ok(s, { [k]: 'a'.repeat(4097) }), k).to.eq(false);
      expect(ok(s, { [k]: ['a', 'b'] }), k).to.eq(false);
    }
    expect(ok(s, { code: 'c', session_state: 's', scope: 'openid', authuser: '0' })).to.eq(true);
  });

  it('the unlink query caps subject at 255', () => {
    const s = schemaOf(OidcUnlinkQuery);
    expect(ok(s, {})).to.eq(true);
    expect(ok(s, { subject: 'a'.repeat(255) })).to.eq(true);
    expect(ok(s, { subject: 'a'.repeat(256) })).to.eq(false);
    expect(ok(s, { subject: 'a', other: 'b' })).to.eq(false);
  });

  it('the back-channel form needs a logout_token of at most 16384 and ignores other fields', () => {
    const s = schemaOf(BackchannelForm);
    expect(ok(s, { logout_token: 'a'.repeat(16384) })).to.eq(true);
    expect(ok(s, { logout_token: 'a'.repeat(16385) })).to.eq(false);
    expect(ok(s, {})).to.eq(false);
    expect(ok(s, { logout_token: ['a', 'b'] })).to.eq(false);
    expect(ok(s, { logout_token: 'a', state: 'x' })).to.eq(true);
  });
});
