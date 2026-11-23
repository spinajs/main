// Type-checked by `tsc -p tsconfig.json` with strict columns (src/orm-strict.d.ts); never run.
import type { ResourceRef } from '@spinajs/authz';
import type { ManyToManyRelationList, ModelBase, OneToManyRelationList } from '@spinajs/orm';

declare const comments: OneToManyRelationList<ModelBase, ModelBase>;
declare const tags: ManyToManyRelationList<ModelBase, ModelBase>;
declare const project: ResourceRef;

export async function oneToManySyncCallback(): Promise<void> {
  await comments.sync(function () {
    this.accessible('comment:delete');
  });
  await comments.sync(function () {
    this.unscoped('nightly import');
  });
  await comments.sync(function () {
    this.within(project);
  });
  await comments.sync(function () {
    this.accessible('comment:delete').where('flag', 'green');
  });
}

export async function manyToManySyncCallback(): Promise<void> {
  await tags.sync(function () {
    this.accessible('post_tag:delete');
  });
  await tags.sync(function () {
    this.unscoped('nightly import');
  });
  await tags.sync(function () {
    this.within([project]);
  });
  await tags.sync(function () {
    this.accessible('post_tag:delete').where('tag_id', 2);
  });
}
