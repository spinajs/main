import assert from 'node:assert/strict';
import type { AppEnv } from '../harness/config.js';
import type { BootSpec } from '../harness/ports.js';
import type { Harness } from '../harness/ports.js';
import { defineCase, defineRule, table } from './types.js';
import type { AuthnRule } from './types.js';

type Secrets = NonNullable<BootSpec['secrets']>;

/**
 * mfaStep 'secret-storing' needs the lane's boot to know that a step stores secrets: no contract member says so, so the
 * lane defines it and its BootPort adapter registers such a step (or throws UnsupportedConfig, which fails a claimed facet).
 */
const baseSpec = (env: AppEnv, secrets: Secrets = {}, extra: Partial<BootSpec> = {}): BootSpec => ({
  env,
  secrets: { cookie: 'strong', pepper: 'off', mfaKey: 'strong', ...secrets },
  mfaStep: 'secret-storing',
  ...extra,
});

async function boots(h: Required<Pick<Harness, 'boot'>>, spec: BootSpec): Promise<boolean> {
  const b = await h.boot.start(spec);
  if (b.ok) {
    await b.dispose();
  }
  return b.ok;
}

const REFUSED_IN_PRODUCTION = [
  { secret: 'cookie', value: 'public' },
  { secret: 'cookie', value: 'missing' },
  { secret: 'mfaKey', value: 'missing' },
] as const;

const ACCEPTED = [
  { secret: 'cookie', value: 'public', env: 'development' },
  { secret: 'cookie', value: 'public', env: 'test' },
  { secret: 'mfaKey', value: 'missing', env: 'development' },
] as const;

const CHECK_ROWS: readonly { readonly topic: string; readonly spec: BootSpec }[] = [
  { topic: 'strategies', spec: baseSpec('production', {}, { config: { authn: { strategies: [] } } }) },
  { topic: 'secrets', spec: baseSpec('production', { cookie: 'missing' }) },
  { topic: 'proxy', spec: baseSpec('production', {}, { config: { authn: { http: { trustProxy: null } } } }) },
  { topic: 'cors', spec: baseSpec('production', {}, { config: { http: { cors: { origins: [] } } } }) },
];

export const A24: AuthnRule = defineRule('A24', 'secrets refuse public or missing values outside development and test', [
  defineCase({
    name: 'A24 a production boot with strong secrets starts',
    facet: 'A24/boot',
    needs: ['boot'],
    async run(h) {
      assert.ok(await boots(h, baseSpec('production')), 'the boot starts');
    },
  }),
  table(REFUSED_IN_PRODUCTION, (row) =>
    defineCase({
      name: `A24 ${row.secret} ${row.value} fails boot in production`,
      facet: 'A24/boot',
      needs: ['boot'],
      async run(h) {
        assert.strictEqual(await boots(h, baseSpec('production', { [row.secret]: row.value })), false);
      },
    }),
  ),
  table(ACCEPTED, (row) =>
    defineCase({
      name: `A24 ${row.secret} ${row.value} boots in ${row.env}`,
      facet: 'A24/boot',
      needs: ['boot'],
      async run(h) {
        assert.ok(await boots(h, baseSpec(row.env, { [row.secret]: row.value })), 'the boot starts');
      },
    }),
  ),
  defineCase({
    name: 'A24 a missing MFA key boots in production without a secret-storing step',
    facet: 'A24/boot',
    needs: ['boot'],
    async run(h) {
      assert.ok(await boots(h, baseSpec('production', { mfaKey: 'missing' }, { mfaStep: 'none' })), 'the boot starts');
    },
  }),
  defineCase({
    name: 'A24 pepper off boots in production',
    facet: 'A24/boot',
    needs: ['boot'],
    async run(h) {
      assert.ok(await boots(h, baseSpec('production', { pepper: 'off' })), 'the boot starts');
    },
  }),
  table(CHECK_ROWS, (row) =>
    defineCase({
      name: `A24 check-config reports ${row.topic}`,
      facet: 'A24/boot',
      needs: ['boot'],
      async run(h) {
        const findings = await h.boot.checkConfig(row.spec);
        assert.ok(
          findings.some((f) => f.topic === row.topic),
          `no ${row.topic} finding in ${JSON.stringify(findings)}`,
        );
      },
    }),
  ),
]);
