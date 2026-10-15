import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IBuilderMiddleware, ModelBase } from '@spinajs/orm';
import type { Permission } from '@spinajs/authz';

export const ACCESS_FIELD = '$access';

export const accessColumn = (i: number): string => `__authz_access_${i}`;

export function accessField(): string {
  const v = DI.get(Configuration)?.get<unknown>(['authz', 'orm', 'accessField']);
  return typeof v === 'string' && v !== '' ? v : ACCESS_FIELD;
}

const truthy = (v: unknown): boolean => v === 1 || v === true || v === '1' || v === 1n;

// dehydrate() emits descriptor columns only, so the answers ride on per-instance overrides.
function attach(model: ModelBase, field: string, access: Readonly<Record<string, boolean>>): void {
  Object.defineProperty(model, field, { value: access, enumerable: true, configurable: true, writable: true });
  for (const method of ['dehydrate', 'dehydrateWithRelations'] as const) {
    const base = (model as unknown as Record<string, (...a: unknown[]) => Record<string, unknown>>)[method];
    Object.defineProperty(model, method, {
      configurable: true,
      writable: true,
      enumerable: false,
      value: function (this: ModelBase, ...args: unknown[]) {
        return { ...base.apply(this, args), [field]: (this as unknown as Record<string, unknown>)[field] };
      },
    });
  }
}

/** Moves the `__authz_access_<i>` columns of each raw row onto the hydrated model as `{ [permission]: boolean }`. */
export class AccessFieldMiddleware implements IBuilderMiddleware {
  private readonly answers: Readonly<Record<string, boolean>>[] = [];

  constructor(private readonly permissions: readonly Permission[], private readonly field: string) {}

  afterQuery(data: unknown[]): unknown[] {
    if (!Array.isArray(data)) return data;
    for (const raw of data as Record<string, unknown>[]) {
      const access: Record<string, boolean> = {};
      this.permissions.forEach((p, i) => {
        access[p] = truthy(raw?.[accessColumn(i)]);
        if (raw) delete raw[accessColumn(i)];
      });
      this.answers.push(Object.freeze(access));
    }
    return data;
  }

  modelCreation(): ModelBase | null {
    return null;
  }

  async afterHydration(models: ModelBase[]): Promise<void> {
    models.forEach((m, i) => {
      const access = this.answers[i];
      if (access !== undefined) attach(m, this.field, access);
    });
  }
}
