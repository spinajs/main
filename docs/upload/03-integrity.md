# Integrity

Every part is checked against its own SHA-256 before it is stored, and every stored part is hashed again while the file is assembled, together with the whole file. A byte that changed on the way or in storage is caught, and only the affected parts have to be sent again.

## How it works

### A part (`UploadService.putPart`)

1. **Before the body is read** (`preflightPart`), in this order:
   - the part number is an integer in `1`..`partCount` (`upload.part_number`);
   - the session is `open` (`upload.not_open`) and not past `expiresAt` (`upload.expired`);
   - `Content-Length` is present (`upload.length_required`) and equals the part's size (`upload.part_size`);
   - a `sha-256` digest is present unless `upload.integrity.partDigest` is `optional` (`upload.digest_required`), and is 32 bytes long (`upload.part_digest_mismatch`).
2. **While the body streams** (`UploadStorage.writePart`):
   - a row in `upload_blobs` (`state: 'writing'`) records the new key `<prefix>/<session>/<part:05>-<uuid>` before anything is written;
   - the body flows through `ByteLimitStream(size)`, then `DigestStream`, then (part 1 only) a capture of the first `upload.detect.headBytes` bytes, into `writeStream(key, { exclusive: true, metadata: { hash } })` on the temp provider. `hash` is the declared digest in hex; a part sent without a digest has no `hash` metadata.
   - One byte over the part's size fails the write with `upload.part_too_large` (413).
3. **After the stream:** a short body is refused with `upload.part_size`, a digest mismatch with `upload.part_digest_mismatch`. The object is removed and no part row is written.
4. **Part 1 only:** the [content check](08-content-checks-and-detectors.md) runs on the captured head.
5. **Commit, in one transaction** (`commitPart`):
   - a conditional `UPDATE` touches the session only while it is `open` and not past `expiresAt`. It takes the row lock that a complete claim also needs, so a part never commits into an assembling session;
   - the `upload_parts` row is upserted with the new key, size and SHA-256;
   - the blob row goes `writing` → `live`. If the sweeper already reclaimed it, the part is refused with `upload.part_lost`;
   - the replaced copy of a resent part becomes `garbage`.
6. **After the commit:** garbage objects are removed, best effort. The sweeper removes what is left.

### The file (`UploadService.complete`)

1. **Declared hash:** from create, or from the complete body. While `upload.integrity.fileDigest` is `required`, complete without one answers `upload.file_digest_required`. A complete hash that differs from the create hash answers `upload.file_digest_mismatch`.
2. **Claim:** a conditional `UPDATE` sets `status: 'assembling'` and a claim token, on an `open` session not past `expiresAt`, or on an `assembling` one whose claim is older than `upload.assembly.staleAfter`. Only the claim holder lists and reads the parts. A request that loses the claim answers from the session's state: the completed view, `upload.assembling`, `upload.expired` or `upload.not_open`.
3. **Missing parts** answer `upload.parts_missing` with `details.parts`, and release the claim.
4. **Assembly** (`UploadStorage.assemble`): a `writing` blob row records the file key `<fileDir>/<uuid><ext>` first. Each part is read with `readStream()`, hashed, and compared with its row's SHA-256. All the bytes go through one whole-file `DigestStream` into `writeStream(key, { exclusive: true, contentType, metadata: { hash } })` on the files provider. `contentType` is the detected MIME type, else the declared one, else `application/octet-stream`. `hash` is the declared file hash, and is absent when none was declared.
5. **A changed part:** once one part fails its hash (or cannot be read), nothing more is written, and the remaining parts are only hashed. The changed parts and the partial file are dropped, the claim is released, and the session is `open` again: `upload.part_corrupted` with `details.parts`. The client sends only those parts.
6. **A file mismatch:** a merged size other than `size` (`upload.size_mismatch`), or a hash other than the declared one (`upload.file_digest_mismatch`), makes the session `failed`. The file and every part are removed: the client sent other bytes than it hashed.
7. **Success:** a conditional `UPDATE` that matches the claim token sets `status: 'completed'`, `sha256`, `file_key` and `detected_mime`. The file blob goes `writing` → `live`; if the sweeper already reclaimed it, the answer is `upload.file_lost` and the claim is released with the parts intact.

## Blob tracking

Every object the upload writes has a row in `upload_blobs` before the first byte is written. The sweeper finds leftovers through these rows only and never lists storage, so cleanup works the same on any provider.

| Blob state | Meaning | Who moves it on |
| --- | --- | --- |
| `writing` | The object is being written, or its writer crashed. | The commit (`live`), a refusal (`garbage`), the sweeper after `upload.assembly.staleAfter` (`garbage`). |
| `live` | A committed part or the merged file. `upload_parts.storage_key` and `upload_sessions.file_key` point only at live blobs. | A resend, a corrupted part, a failed assembly, an abort, expiry or the purge (`garbage`). |
| `garbage` | To be removed. | `UploadStorage.removeObject()`: removes the object, then deletes the row. A failed removal keeps the row for the next sweep. |

- Keys are never reused: each write gets a new UUID. A resend, or two concurrent writes of the same part, cannot truncate or mix with the stored copy; the row decides which copy is current.
- Writes are exclusive (`exclusive: true`). With unique keys they never meet an existing object; on S3 the guarantee is only as strong as the backend's conditional writes. See [Storage providers](07-storage-providers.md#important-behaviour).
- Every state change is a conditional `UPDATE` that names the state it leaves, so a row the sweeper took over is never flipped back to `live`.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `upload.integrity.partDigest` | `string` | `'required'` | `'required'`, `'optional'` | `optional`: a part without a digest is stored after the length check only. |
| `upload.integrity.fileDigest` | `string` | `'required'` | `'required'`, `'optional'` | `optional`: complete without a declared hash checks the size and the part hashes only. |
| `upload.detect.headBytes` | `integer` | `4100` | `1`..`65536` | Bytes of part 1 captured for the content check. |
| `upload.assembly.staleAfter` | `string` | `'30m'` | a duration above zero | Claim and `writing` blob age after which they count as abandoned. Must exceed the slowest part transfer and assembly. |

## Important behaviour

- **The checked bytes are the stored bytes.** The content type of part 1 is checked after its digest check, and part 1 is re-hashed at assembly, so the bytes that passed the check are the bytes in the file.
- **Assembly never trusts metadata.** It re-reads each part through `readStream()`; it does not call `hash()`, whose S3 fast path returns the stored `hash` metadata.
- **The stored `hash` metadata is the declared digest.** The part or file is removed when the computed hash differs, so a kept object's `hash` equals its content.
- **A slow write loses its object.** A part write or an assembly that runs longer than `upload.assembly.staleAfter` can see its `writing` blob reclaimed by the sweeper: `upload.part_lost` or `upload.file_lost`, and the client retries.
- **A failed session keeps no data.** After a file mismatch the client creates a new session.

## Best practices

- Keep `upload.integrity.partDigest` at `required`. Without a part digest a corrupted part is found only at assembly, after the whole file was sent.
- Keep `upload.integrity.fileDigest` at `required` for anything you store long-term. The SHA-256 in the completed view and in `UploadCompleted` is then the hash the client computed, not one the server made up.
- Store `sha256` from the completed view (or the `UploadCompleted` event) with your own record of the file: it lets you verify the file later with `hash()`.

## Related

- [Wire protocol](01-protocol.md#errors): the error codes and statuses.
- [File hashing](../fs/09-file-hashing.md) and [Streams](../fs/12-streams.md): `DigestStream` and `ByteLimitStream`.
- [Sweeper](11-sweeper.md): how `writing` and `garbage` blobs are removed.
