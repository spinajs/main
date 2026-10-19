import type { AssignmentSubject, PrincipalRef } from '@spinajs/authz';

/** One row of the file ACL: `subject` holds `relation` on `path` of `fs` and on everything under it (D7). */
export interface FsAclRow {
  readonly fs: string;
  /** Normalised; '' is the filesystem root. */
  readonly path: string;
  /** A principal, `{ type, id: '*' }` for every principal of a type, or a subject set (D8). */
  readonly subject: AssignmentSubject;
  readonly relation: string;
  readonly expiresAt?: Date;
  /** principalKey of whoever granted the row. */
  readonly grantedBy?: string;
}

/**
 * The file ACL (fs middleware design §3.1). Paths are normalised without a base path ('' = the root); subject keys
 * are authz-rbac `subjectKeyOf` keys. AuthzFsMiddleware keeps it in step with the files; system code may call it
 * directly, apps go through FsAcl.
 */
export abstract class FileAclStore {
  /** Whether a live row of `relation` at one of `paths` names one of `subjectKeys` at `at`. */
  abstract holds(fs: string, paths: readonly string[], subjectKeys: readonly string[], relation: string, at: Date): Promise<boolean>;
  /** The rows at exactly `path`, expired ones included. */
  abstract list(fs: string, path: string): Promise<readonly FsAclRow[]>;
  /** Idempotent on (fs, path, subject, relation): a second grant replaces `expiresAt` and `grantedBy`. */
  abstract grant(row: FsAclRow): Promise<void>;
  abstract revoke(fs: string, path: string, subjectKey: string, relation: string): Promise<void>;
  /** The principal of the oldest `owner` row at exactly `path` (set and wildcard rows skipped); null without one. */
  abstract ownerOf(fs: string, path: string): Promise<PrincipalRef | null>;
  /** Adds an `owner` row for `owner` unless `path` has an owner row already (first writer wins). */
  abstract setOwnerIfAbsent(fs: string, path: string, owner: PrincipalRef): Promise<void>;
  /** The rows at `path` and under it; '' takes every row of the filesystem. */
  abstract deleteTree(fs: string, path: string): Promise<void>;
  /** The rows at exactly `path`. */
  abstract deletePath(fs: string, path: string): Promise<void>;
  /** Moves the rows at `from` and under it to `to` on `toFs`; a moved row replaces an equal one there. */
  abstract moveTree(fromFs: string, from: string, toFs: string, to: string): Promise<void>;
  /** Moves the rows at exactly `from` (none under it) to `to` on `toFs`; a moved row replaces an equal one there. */
  abstract movePath(fromFs: string, from: string, toFs: string, to: string): Promise<void>;
}
