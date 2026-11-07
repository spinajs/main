import { Archived, Bool, Column, DateTime, Model, ModelBase, Primary, SoftDelete, UpdatedAt } from '@spinajs/orm';
import { DateTime as Instant } from 'luxon';

@Model('events')
export class Event extends ModelBase<Event> {
  @Primary() public Id: bigint;
  @Primary({ generated: 'assigned' }) public Seq: number;
  public Count?: number | null;
  public At: Instant;
  public Blob: Buffer;
  public Payload: { a: number };
  @Bool() public Flag: number;
  @DateTime() public Stamp: string;
  @UpdatedAt() public UpdatedAt: Instant;
  @SoftDelete() public DeletedAt: Instant;
  @Archived() public ArchivedAt: Instant;
  @Column({ unique: true }) public Code: string;
  @Column({ family: 'enum', enumValues: ['a', 'b'] }) public Grade: string;
}
