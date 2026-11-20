import { runAcrossTenants, runAcrossTenants as everywhere } from '../vendor/tenancy/index.js';
import * as tenancy from '../vendor/tenancy/index.js';
import { Invoice, Payment } from './models.js';

declare function reasonOf(): string;

export async function dunning(): Promise<void> {
  await Invoice.query().acrossTenants('nightly dunning report');
}

export async function viaBuilder(): Promise<void> {
  const query = Payment.where('Id', 1);
  await query.acrossTenants(reasonOf());
}

export async function scopes(): Promise<void> {
  await runAcrossTenants('usage rollup', async () => undefined);
  await everywhere('an alias still counts', async () => undefined);
  await tenancy.runAcrossTenants(`plain template`, async () => undefined);
  await runAcrossTenants(reasonOf(), async () => undefined);
  const REASON = 'a bound constant';
  const day = 1;
  await runAcrossTenants(REASON, async () => undefined);
  await runAcrossTenants(`rollup ${day}`, async () => undefined);
  await runAcrossTenants('nightly ' + 'rollup', async () => undefined);
  await runAcrossTenants('  ', async () => undefined);
}
