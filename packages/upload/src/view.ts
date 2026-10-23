import type { DateTime } from 'luxon';

import type { UploadPart } from './models/UploadPart.js';
import type { UploadSession } from './models/UploadSession.js';
import { contiguousOffset, missingParts } from './parts.js';
import type { UploadStateView } from './types.js';

export const isoOf = (at: DateTime): string => new Date(at.toMillis()).toISOString();

/** Spec §3. `mime` is the detected type, known once part 1 is stored; `sha256` only once completed. */
export function toStateView(session: UploadSession, parts: readonly UploadPart[]): UploadStateView {
  const received = [...parts].sort((a, b) => a.number - b.number).map((p) => ({ number: p.number, size: p.size, sha256: p.sha256 }));
  const numbers = received.map((p) => p.number);
  const mime = session.detected_mime ?? parts.find((p) => p.number === 1)?.detected_mime ?? null;
  return {
    id: session.id,
    status: session.status,
    name: session.name,
    size: session.size,
    partSize: session.part_size,
    partCount: session.part_count,
    receivedParts: received,
    missingParts: missingParts(session.part_count, numbers),
    offset: contiguousOffset(session.size, session.part_size, numbers),
    expiresAt: isoOf(session.expires_at),
    ...(session.status === 'completed' && session.sha256 !== null ? { sha256: session.sha256 } : {}),
    ...(mime !== null ? { mime } : {}),
    ...(session.failure_code !== null ? { failure: { code: session.failure_code, message: session.failure_message ?? session.failure_code } } : {}),
  };
}
