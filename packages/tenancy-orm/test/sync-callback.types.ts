// Type-checked by `tsc -p tsconfig.json` with strict columns (src/orm-strict.d.ts); never run.
import type { ManyToManyRelationList, ModelBase, OneToManyRelationList } from '@spinajs/orm';

declare const lines: OneToManyRelationList<ModelBase, ModelBase>;
declare const tags: ManyToManyRelationList<ModelBase, ModelBase>;

export async function oneToManySyncCallback(): Promise<void> {
  await lines.sync(function () {
    this.acrossTenants('tenant merge');
  });
  await lines.sync(function () {
    this.acrossTenants('tenant merge').where('sku', 'legacy');
  });
}

export async function manyToManySyncCallback(): Promise<void> {
  await tags.sync(function () {
    this.acrossTenants('tenant merge');
  });
  await tags.sync(function () {
    this.acrossTenants('tenant merge').where('tag_id', 2);
  });
}
