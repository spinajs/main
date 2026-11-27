import { Model, ModelBase, Primary } from '@spinajs/orm';
import { AccessResource, registerAccessResource } from '@spinajs/authz-orm';

@Model('same')
export class Same extends ModelBase<Same> {
  @Primary() public Id: number;
}

@Model('other')
export class Other extends ModelBase<Other> {
  @Primary() public Id: number;
}

@AccessResource('decorated', { rls: true })
@Model('decorated')
export class Decorated extends ModelBase<Decorated> {
  @Primary() public Id: number;
}

declare const dynamic: string;
declare const built: { owner: string };
registerAccessResource(Same, 'same', { owner: 'OwnerId', relations: { b: 'B', a: { column: 'A', typeColumn: 'AType' } } });
registerAccessResource(Same, 'same', { relations: { a: { column: 'A', typeColumn: 'AType' }, b: 'B' }, owner: { column: 'OwnerId' }, changelog: true });
registerAccessResource(Other, 'other', { owner: 'OwnerId' });
registerAccessResource(Other, 'other', { owner: 'AuthorId' });
registerAccessResource(Decorated, 'decorated');
registerAccessResource(Same, 'same', { owner: dynamic });
registerAccessResource(Same, 'same', built);

declare const shared: { owner: string };
let late = { owner: 'AuthorId' };
late = { owner: 'OwnerId' };
registerAccessResource(Other, 'other', { ...shared });
registerAccessResource(Other, 'other', late);

const PARTIAL = { rls: 'partial' } as const;

@AccessResource('partial', PARTIAL satisfies { rls: 'partial' })
@Model('partial')
export class Partial extends ModelBase<Partial> {
  @Primary() public Id: number;
}

registerAccessResource(Partial, 'partial', { rls: 'partial' });
registerAccessResource(Partial, 'partial', { rls: true });
