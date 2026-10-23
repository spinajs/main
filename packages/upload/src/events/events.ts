import { NewInstance } from '@spinajs/di';
import { Event, QueueEvent } from '@spinajs/queue';

import type { UploadStatus } from '../types.js';

/** What every upload event copies from its session; an UploadSession row fits. */
export interface UploadEventSource {
  readonly id: string;
  readonly owner: string | null;
  readonly name: string;
  readonly size: number;
  readonly metadata: Record<string, unknown>;
  readonly temp_fs: string;
  readonly files_fs: string;
  readonly status: UploadStatus;
}

/**
 * Every argument is optional: QueueService.consume builds a delivered event with DI.resolve(EventClass) and then
 * hydrates it (queue/src/index.ts:158-159). The file name is `FileName`, because QueueMessage.Name is the event name
 * that routing reads (queue/src/interfaces.ts:71-73).
 */
@Event()
@NewInstance()
export class UploadEvent extends QueueEvent {
  public UploadId: string;

  public Owner: string | null;

  public FileName: string;

  public Size: number;

  /** The app's session metadata; it must not hold secrets (spec §6.6). */
  public Metadata: Record<string, unknown>;

  public TempFs: string;

  public FilesFs: string;

  public Status: UploadStatus;

  constructor(session?: UploadEventSource) {
    super();

    if (session) {
      this.UploadId = session.id;
      this.Owner = session.owner;
      this.FileName = session.name;
      this.Size = session.size;
      this.Metadata = { ...session.metadata };
      this.TempFs = session.temp_fs;
      this.FilesFs = session.files_fs;
      this.Status = session.status;
    }
  }
}

export interface UploadCreatedFields {
  PartSize: number;
  PartCount: number;
  DeclaredMime: string | null;
  DeclaredSha256?: string;
  ExpiresAt: string;
}

@Event()
export class UploadCreated extends UploadEvent {
  public PartSize: number;
  public PartCount: number;
  public DeclaredMime: string | null;
  public DeclaredSha256?: string;
  public ExpiresAt: string;

  constructor(session?: UploadEventSource, fields?: UploadCreatedFields) {
    super(session);
    Object.assign(this, fields);
  }
}

export interface UploadPartStoredFields {
  Part: number;
  PartSize: number;
  PartSha256: string;
  Offset: number;
  ReceivedParts: number;
  PartCount: number;
  /** A resend replaced an older copy of the part. */
  Replaced: boolean;
}

@Event()
export class UploadPartStored extends UploadEvent {
  public Part: number;
  public PartSize: number;
  public PartSha256: string;
  public Offset: number;
  public ReceivedParts: number;
  public PartCount: number;
  public Replaced: boolean;

  constructor(session?: UploadEventSource, fields?: UploadPartStoredFields) {
    super(session);
    Object.assign(this, fields);
  }
}

export interface UploadPartRejectedFields {
  Part: number;
  /** An UploadErrorCode, e.g. upload.part_digest_mismatch. */
  Code: string;
}

@Event()
export class UploadPartRejected extends UploadEvent {
  public Part: number;
  public Code: string;

  constructor(session?: UploadEventSource, fields?: UploadPartRejectedFields) {
    super(session);
    Object.assign(this, fields);
  }
}

export interface UploadContentCheckedFields {
  DeclaredMime: string | null;
  DetectedMime?: string;
  DetectorId?: string;
  Accepted: boolean;
}

@Event()
export class UploadContentChecked extends UploadEvent {
  public DeclaredMime: string | null;
  public DetectedMime?: string;
  public DetectorId?: string;
  public Accepted: boolean;

  constructor(session?: UploadEventSource, fields?: UploadContentCheckedFields) {
    super(session);
    Object.assign(this, fields);
  }
}

export interface UploadAssemblyStartedFields {
  ClaimToken: string;
  PartCount: number;
}

@Event()
export class UploadAssemblyStarted extends UploadEvent {
  public ClaimToken: string;
  public PartCount: number;

  constructor(session?: UploadEventSource, fields?: UploadAssemblyStartedFields) {
    super(session);
    Object.assign(this, fields);
  }
}

export interface UploadPartCorruptedFields {
  Parts: number[];
}

@Event()
export class UploadPartCorrupted extends UploadEvent {
  public Parts: number[];

  constructor(session?: UploadEventSource, fields?: UploadPartCorruptedFields) {
    super(session);
    Object.assign(this, fields);
  }
}

export interface UploadAssemblyReleasedFields {
  Reason: 'error' | 'stale';
}

@Event()
export class UploadAssemblyReleased extends UploadEvent {
  public Reason: 'error' | 'stale';

  constructor(session?: UploadEventSource, fields?: UploadAssemblyReleasedFields) {
    super(session);
    Object.assign(this, fields);
  }
}

export interface UploadCompletedFields {
  Sha256: string;
  Mime: string;
  FileKey: string;
  CompletedAt: string;
}

@Event()
export class UploadCompleted extends UploadEvent {
  public Sha256: string;
  public Mime: string;
  public FileKey: string;
  public CompletedAt: string;

  constructor(session?: UploadEventSource, fields?: UploadCompletedFields) {
    super(session);
    Object.assign(this, fields);
  }
}

export interface UploadFailedFields {
  Code: string;
  Message: string;
}

@Event()
export class UploadFailed extends UploadEvent {
  public Code: string;
  public Message: string;

  constructor(session?: UploadEventSource, fields?: UploadFailedFields) {
    super(session);
    Object.assign(this, fields);
  }
}

@Event()
export class UploadAborted extends UploadEvent {}

export interface UploadExpiredFields {
  ExpiresAt: string;
}

@Event()
export class UploadExpired extends UploadEvent {
  public ExpiresAt: string;

  constructor(session?: UploadEventSource, fields?: UploadExpiredFields) {
    super(session);
    Object.assign(this, fields);
  }
}

export interface UploadPurgedFields {
  /** Blobs removed. */
  Blobs: number;
}

@Event()
export class UploadPurged extends UploadEvent {
  public Blobs: number;

  constructor(session?: UploadEventSource, fields?: UploadPurgedFields) {
    super(session);
    Object.assign(this, fields);
  }
}

export const UPLOAD_EVENTS = [
  UploadCreated,
  UploadPartStored,
  UploadPartRejected,
  UploadContentChecked,
  UploadAssemblyStarted,
  UploadPartCorrupted,
  UploadAssemblyReleased,
  UploadCompleted,
  UploadFailed,
  UploadAborted,
  UploadExpired,
  UploadPurged,
] as const;

export const UPLOAD_EVENT_NAMES: readonly string[] = UPLOAD_EVENTS.map((e) => e.name);
