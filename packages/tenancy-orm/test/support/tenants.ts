import type { TenantPlacement, TenantState } from '@spinajs/tenancy';
import { DateTime } from 'luxon';

import { TenantModel } from '../../src/index.js';

export interface TenantSeed {
  id: string;
  slug?: string;
  name?: string;
  state?: TenantState;
  domains?: string[];
  placement?: TenantPlacement | null;
  settings?: Record<string, unknown>;
}

export async function seedTenant(seed: TenantSeed): Promise<void> {
  const now = DateTime.utc();
  const row = new TenantModel({
    id: seed.id,
    slug: seed.slug ?? seed.id,
    name: seed.name ?? seed.id,
    state: seed.state ?? 'active',
    domains: seed.domains ?? [],
    placement: seed.placement ?? null,
    settings: seed.settings ?? {},
    created_at: now,
    updated_at: now,
  });
  await row.insert();
}

export async function clearTenants(): Promise<void> {
  await TenantModel.destroy().where('id', '!=', '');
}
