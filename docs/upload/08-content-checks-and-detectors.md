# Content checks and detectors

The upload compares two MIME types: the one the file name declares and the one the first bytes of part 1 show. A mismatch is refused, and so is a type the controller does not accept. Formats the built-in detection does not know get a `ContentDetector` from your app.

## How it works

1. **At create**, `ContentTypeCheck.mimeOf(name)` maps the name's extension with `mime-types` to the declared type. The client's `Content-Type` is never used.
   - No type for the extension: `400` `upload.unsupported_type`, unless the controller's `allowUnknownType()` is `true`; the declared type is then `null`.
   - A type outside `allowedTypes()`: `415` `upload.unsupported_type`.
2. **While part 1 streams**, its first `upload.detect.headBytes` bytes (default 4100) are captured.
3. **After part 1 passed its length and digest checks**, `ContentTypeCheck.check()` runs `file-type`'s `FileTypeParser` on the head, with every registered `ContentDetector` as a custom detector. Custom detectors run before the built-in ones; the first match wins.
4. The rules, in order:

| Case | Result |
| --- | --- |
| Nothing detected, and the declared type is in `upload.detect.allowUndetected` (default `text/plain`, `text/csv`) | the declared type goes on to the last rule |
| Nothing detected otherwise, also with no declared type | `415` `upload.content_mismatch` |
| Detected, and no declared type (`allowUnknownType()` is `true`) | the mismatch test is skipped; the detected type goes on to the last rule |
| Detected type equals the declared type, or the detected extension maps (with `mime-types`) to the declared type | the detected type goes on to the last rule |
| Detected type differs from the declared type | `415` `upload.content_mismatch` |
| The detected type (or the declared one, when nothing was detected) is not in `allowedTypes()` | `415` `upload.unsupported_type` |

5. A refused part 1 is removed and no part row is written. `UploadContentChecked` reports the check either way, with `DeclaredMime`, `DetectedMime`, `DetectorId` (`'file-type'` for the built-in detectors) and `Accepted`.
6. An accepted part 1 stores the detected type on its row. Complete copies it to the session; the merged file is written with it as its content type.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `upload.detect.headBytes` | `integer` | `4100` | `1`..`65536` | Bytes of part 1 the detectors see. Raise it for formats whose signature sits further in. |
| `upload.detect.allowUndetected` | `string[]` | `['text/plain', 'text/csv']` | MIME types | Declared types accepted when nothing recognises the content. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `ContentDetector` | abstract class; every registration, resolved as `Array.ofType(ContentDetector)` on each check | none: the package ships no detector | your detectors | `@Injectable(ContentDetector)` on a subclass; importing the module registers it. |
| `ContentTypeCheck` | `ContentTypeCheck`, `@Singleton()` | `mime-types` + `file-type` | your subclass | `DI.register(MyCheck).as(ContentTypeCheck)` before `UploadService` resolves. Prefer a detector. |

`ContentDetector`:

```ts
export abstract class ContentDetector {
  public abstract readonly id: string;
  /** Sees the first upload.detect.headBytes bytes of part 1; returns null when the content is not this detector's. */
  public abstract detect(head: Uint8Array): Promise<{ ext: string; mime: string } | null>;
}
```

- `id` names the detector in `UploadContentChecked.DetectorId` and in the logs.
- `detect()` gets the captured head, not a stream. Return `{ ext, mime }` for your format and `null` for anything else, so the next detector and then `file-type` get their turn.
- A detector that throws is logged at `warn` and counts as no match.

### `ContentDetector`: custom implementation

`file-type` knows no DXF. This detector recognises the format by its structure only: ASCII DXF is a list of group-code / value line pairs whose first pair (after optional `999` comments) opens a section, and binary DXF starts with a fixed sentinel. It reads no section, layer or block names, so it accepts any DXF the producing tool writes.

```ts sample
import { Injectable } from '@spinajs/di';
import { ContentDetector } from '@spinajs/upload';
import type { DetectedContent } from '@spinajs/upload';

const BINARY_SENTINEL = 'AutoCAD Binary DXF\r\n\x1a\0';
const COMMENT = 999;

@Injectable(ContentDetector)
export class DxfDetector extends ContentDetector {
  public readonly id = 'dxf';

  public async detect(head: Uint8Array): Promise<DetectedContent | null> {
    const text = Buffer.from(head).toString('latin1');
    if (text.startsWith(BINARY_SENTINEL)) return { ext: 'dxf', mime: 'image/vnd.dxf' };

    // drop a UTF-8 byte order mark, then read the head as group-code / value line pairs
    const lines = text.replace(/^\xef\xbb\xbf/, '').split(/\r?\n/);
    let at = 0;
    while (at + 1 < lines.length && Number(lines[at].trim()) === COMMENT) at += 2;
    if (at + 3 >= lines.length) return null;

    const opensSection = lines[at].trim() === '0' && lines[at + 1].trim() === 'SECTION';
    const namesIt = lines[at + 2].trim() === '2' && lines[at + 3].trim() !== '';
    return opensSection && namesIt ? { ext: 'dxf', mime: 'image/vnd.dxf' } : null;
  }
}
```

`mime-types` maps `.dxf` to `image/vnd.dxf`, so a `.dxf` name and DXF content match. Import the module at boot, and list `image/vnd.dxf` in the controller's `allowedTypes()`.

## Important behaviour

- **Custom detectors run first.** A detector can claim bytes that `file-type` would recognise too, so keep each one specific to its format.
- **`file-type` matches a PDF only at byte 0.** A PDF with leading bytes before `%PDF` needs a detector of your own.
- **Some names differ between `file-type` and `mime-db`** (`.ico`, `.avi`, `.eps`). The check compares the detected extension through `mime-types` too, so these are accepted.
- **Legacy Office files are refused.** `.doc` and `.xls` are detected as the compound file container `application/x-cfb`, whose real type the head cannot show; they fail as `upload.content_mismatch`. Write a detector if you accept them.
- **A head cut inside a container** (a zip-based format whose first entry is longer than `headBytes`) makes `file-type` fail; that counts as nothing detected, and is logged at `warn`. The undetected rules then decide.
- **Only part 1 is checked.** Part 1 is re-hashed at assembly, so the bytes that passed the check are the bytes in the file.
- **Detection is not a malware scan.** It tells the format, not whether the file is safe. Scan in `onCompleted` or on `UploadCompleted` when you need to.

## Best practices

- Return a MIME type from your detector that `mime-types` gives for the file extension, or the declared and detected types never match.
- Keep `detect()` cheap and free of IO: it runs inside the part 1 request.
- Name `allowedTypes()` explicitly on every controller that feeds a parser.

## Related

- [Integrity](03-integrity.md): where the check sits in the part flow.
- [Extending the controller](04-extending-the-controller.md): `allowedTypes()` and `allowUnknownType()`.
- [File metadata](../fs/10-file-metadata.md): `file-type` checks of local files in `@spinajs/fs`.
