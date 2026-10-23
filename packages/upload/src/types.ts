export type UploadStatus = 'open' | 'assembling' | 'completed' | 'failed' | 'aborted' | 'expired';

/** The final event a session owes once it is final (spec §6.6). */
export type FinalEventName = 'UploadCompleted' | 'UploadFailed' | 'UploadAborted' | 'UploadExpired';

export type DigestPolicy = 'required' | 'optional';

/** MIME types a controller accepts, or '*' for any. */
export type AllowedTypes = readonly string[] | '*';

export interface UploadLimits {
  maxFileSize: number;
  partSize: number;
  minPartSize: number;
  maxPartSize: number;
  maxParts: number;
  maxOpenSessionsPerOwner: number;
  /** A duration such as '24h' (see parseDuration). */
  sessionTtl: string;
}

export interface UploadConfig {
  fs: { temp: string; files: string; prefix: string };
  limits: UploadLimits;
  integrity: { partDigest: DigestPolicy; fileDigest: DigestPolicy };
  detect: { headBytes: number; allowUndetected: string[] };
  assembly: { staleAfter: string };
  sweeper: { every: string; retainFinished: string; batch: number };
}

export interface ReceivedPartView {
  number: number;
  size: number;
  sha256: string;
}

/** Spec §3: the session state, which is also the resume answer. */
export interface UploadStateView {
  id: string;
  status: UploadStatus;
  name: string;
  size: number;
  partSize: number;
  partCount: number;
  receivedParts: ReceivedPartView[];
  missingParts: number[];
  /** Bytes in the contiguous run of stored parts from part 1. */
  offset: number;
  expiresAt: string;
  sha256?: string;
  mime?: string;
  failure?: { code: string; message: string };
}

/** Spec §3: the answer to one stored part. */
export interface PartStoredView {
  part: number;
  size: number;
  sha256: string;
  offset: number;
  missingParts: number[];
}

export interface CreateUploadInput {
  name: string;
  size: number;
  /** Hex sha-256 of the whole file; required at create or at complete while upload.integrity.fileDigest is 'required'. */
  sha256?: string;
  partSize?: number;
  metadata?: Record<string, unknown>;
  /** Opaque owner stamped on the session; null or absent leaves it unowned. */
  owner?: string | null;
  /** A controller's limits; they can only tighten the configured ones. */
  limits?: Partial<UploadLimits>;
  allowedTypes?: AllowedTypes;
  /** Accept a name that mime-types cannot map (spec §4.3). */
  allowUnknownType?: boolean;
  /** Provider names for this session; default upload.fs.temp / upload.fs.files. */
  fs?: { temp?: string; files?: string };
}

export interface PutPartOptions {
  /** Checked against part 1's content (spec §4.3); default '*'. */
  allowedTypes?: AllowedTypes;
}

export interface CompleteInput {
  /** Hex sha-256 of the file, when it was not declared at create. */
  sha256?: string;
}
