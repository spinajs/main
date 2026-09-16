import { Connection, CreatedAt, DateTime as DateTimeColumn, Model, ModelBase, Primary } from '@spinajs/orm';
import { DateTime } from 'luxon';

/**
 * `UploadedBy` is a plain rbac user id, without a relation: this package deliberately does not
 * depend on @spinajs/rbac. configuration-http resolves the uploaders.
 */
@Connection('default')
@Model('configuration_file_history')
export class DbConfigFileHistory extends ModelBase<DbConfigFileHistory> {
  @Primary()
  public Id!: number;

  public Slug!: string;

  /** Provider name at upload time. */
  public Fs!: string;

  /** Path in the provider when uploaded. */
  public FileName!: string;

  public OriginalName!: string;

  public Size!: number;

  /** sha256 of the content, hex. */
  public Hash!: string;

  public UploadedBy!: number;

  @CreatedAt()
  public UploadedAt!: DateTime;

  public ArchivedPath?: string | null;

  // Declared optional rather than `DateTime | null`: an explicit union in the type
  // annotation erases to `Object` in emitted design:type metadata (regardless of the
  // `?` modifier), which fails the @DateTimeColumn() type check below. `undefined`
  // is the "not archived yet" value instead of `null` (see the model test).
  // A row hydrated from a SELECT has `ArchivedAt === null` for an unarchived NULL column
  // despite this type, so callers must check `== null`, never `=== undefined`.
  @DateTimeColumn()
  public ArchivedAt?: DateTime;
}
