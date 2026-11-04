import { ModelBase, Model, Primary } from '@spinajs/orm';
import { JobModel } from '@spinajs/queue';
import { AccessResource, Owner, Parent, Relation, Self, registerAccessResource } from '@spinajs/authz-orm';

@AccessResource('doc')
export abstract class Document<T> extends ModelBase<T> {
  @Primary() public Id: number;
  @Parent('folder') public FolderId: number;
  @Owner() public OwnerId: number;
}

@Model('notes')
export class Note extends Document<Note> {
  @Relation('editor') public EditorId: number;
  @Self() public SelfId: number;
}

@Model('plain')
export class Plain extends ModelBase<Plain> {
  @Primary() public Id: number;
  public OwnerColumn: number;
}

@Model('tags')
export class Tag extends ModelBase<Tag> {
  @Primary() public Id: number;
}

registerAccessResource(Plain, 'plain', { owner: { column: 'OwnerColumn', typeColumn: 'OwnerType' }, parents: [{ column: 'FolderId', type: 'folder' }], relations: { reviewer: 'ReviewerId' } });
registerAccessResource(JobModel, 'job');
