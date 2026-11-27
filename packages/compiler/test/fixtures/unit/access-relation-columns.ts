import { Model, ModelBase, Primary } from '@spinajs/orm';
import { AccessResource, Owner, Parent, Relation, registerAccessResource } from '@spinajs/authz-orm';
import { MUTABLE_TYPE_COLUMN, SHARED_TYPE_COLUMN } from './access-relation-columns-consts.js';

declare const unknownOptions: { typeColumn: string };
declare const moreOptions: { self?: string };
declare function relationOptions(): { typeColumn: string };
declare function keyOf(): 'typeColumn';
class Marker {}

const TYPED = { typeColumn: 'ConstType' };
const KEY = 'typeColumn';
const typeColumn = 'ShortType';
let late = false;
late = true;
let lateType = 'FirstType';
lateType = 'LastType';

@AccessResource('ticket')
@Model('tickets')
export class Ticket extends ModelBase<Ticket> {
  @Primary() public Id: number;
  @Parent('queue', { nullable: true }) public QueueId: number | null;
  @Parent('project') public ProjectId: number;
  @Parent('board', { nullable: false }) public BoardId: number;
  @Parent('lane', { nullable: late }) public LaneId: number | null;
  @Owner({ typeColumn: 'OwnerType' }) public OwnerId: number;
  @Relation('watcher', { typeColumn: 'WatcherType' }) public WatcherId: number;
  @Relation('reviewer') public ReviewerId: number;
  @Relation('constant', TYPED) public ConstantId: number;
  @Relation('imported', { typeColumn: SHARED_TYPE_COLUMN }) public ImportedId: number;
  @Relation('asConst', { typeColumn: 'AsConstType' } as const) public AsConstId: number;
  @Relation('satisfied', { typeColumn: 'SatisfiedType' } satisfies { typeColumn: string }) public SatisfiedId: number;
  @Relation('shorthand', { typeColumn }) public ShorthandId: number;
  @Relation('spread', { ...TYPED }) public SpreadId: number;
  @Relation('computed', { [KEY]: 'ComputedType' }) public ComputedId: number;
  @Relation('overridden', { ...unknownOptions, typeColumn: 'LastWins' }) public OverriddenId: number;
  @Relation('called', relationOptions()) public CalledId: number;
  @Relation('reassigned', { typeColumn: lateType }) public ReassignedId: number;
  @Relation('importedLet', { typeColumn: MUTABLE_TYPE_COLUMN }) public ImportedLetId: number;
  @Relation('unreadSpread', { ...unknownOptions }) public UnreadSpreadId: number;
  @Relation('unreadKey', { [keyOf()]: 'KeyType' }) public UnreadKeyId: number;
  // A type error on purpose: the run time throws, and the build must not take the class name for a column.
  @Relation('classRef', { typeColumn: Marker }) public ClassRefId: number;
}

@AccessResource('subTicket')
@Model('sub_tickets')
export class SubTicket extends Ticket {}

@Model('registered')
export class Registered extends ModelBase<Registered> {
  @Primary() public Id: number;
}

@Model('partly')
export class Partly extends ModelBase<Partly> {
  @Primary() public Id: number;
}

@Model('lately')
export class Lately extends ModelBase<Lately> {
  @Primary() public Id: number;
}

registerAccessResource(Registered, 'registered', { owner: { column: 'OwnerId', typeColumn: 'OwnerType' }, parents: [{ column: 'FolderId', type: 'folder' }], relations: { editor: { column: 'EditorId', typeColumn: 'EditorType' }, viewer: 'ViewerId' } });
registerAccessResource(Partly, 'partly', { owner: { column: 'OwnerId', typeColumn: 'OwnerType' }, relations: { editor: 'EditorId' }, ...moreOptions });
registerAccessResource(Lately, 'lately', { owner: { column: 'OwnerId', typeColumn: lateType } });
