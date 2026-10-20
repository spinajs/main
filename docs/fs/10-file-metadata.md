# File metadata

`FileInfoService` extracts metadata from a file or a stream: size, dates, MIME type, image dimensions, video duration, codec, frame rate and every other tag the analyzer emits. The default implementation runs the `exiftool` command line tool.

## How it works

1. `provider.metadata(path)` resolves `FileInfoService` and calls `getInfo(provider.resolvePath(path))`. `fileInfo(path)` does the same for an absolute local path.
2. `DefaultFileInfo.getInfo()` throws `IOFail` when the file does not exist.
3. It finds the binary: `fs.fileInfo.exifToolPath`, else the vendored binary of `exiftool-vendored.exe` (Windows) or `exiftool-vendored.pl` (other platforms), else `exiftool` on `PATH`. The exported `resolveExifToolPath()` does this lookup; its result is cached per instance.
4. It spawns `exiftool <fs.fileInfo.args> <file>`. `getInfoFromStream(stream)` passes `-` and pipes the stream to stdin instead.
5. A non-zero exit code, a spawn error, an input stream error or the `fs.fileInfo.timeout` (process killed) reject with `IOFail`. Output on stderr alone is not an error.
6. `parseMetadata()` splits each output line on the first `': '`, turns the tag name into camelCase (`Image Width` → `imageWidth`), and converts values: date-shaped strings to luxon `DateTime`, numeric strings to numbers.
7. `toFileInfo()` copies every tag into `IFileInfo`: known tags under their alias (table below), the rest under the PascalCase tag name. The whole parsed map is in `Raw`.

| exiftool tag | `IFileInfo` field |
| --- | --- |
| `imageWidth`, `imageHeight` | `Width`, `Height` |
| `duration`, `playDuration` | `Duration` |
| `frameCount` | `FrameCount` |
| `frameRate`, `videoFrameRate` | `FrameRate` |
| `audioChannels` | `AudioChannels` |
| `maxBitrate`, `maxDataRate`, `avgBitrate` | `Bitrate` |
| `compressorID` | `Codec` |
| `fileSize` | `FileSize` |
| `mimeType`, `mimeEncoding` | `MimeType`, `Encoding` |
| `wordCount`, `lineCount` | `WordCount`, `LineCount` |
| `fileAccessDateTime`, `fileCreationDateTime`, `fileModificationDateTime` | `AccessDate`, `CreationDate`, `ModificationDate` |

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `fs.fileInfo.exifToolPath` | `string` | unset (auto-resolved) | path to an `exiftool` binary | Binary to run. |
| `fs.fileInfo.timeout` | `number` | `30000` | ms | Kill `exiftool` after this time. |
| `fs.fileInfo.args` | `string[]` | `['-n']` | `exiftool` flags | Arguments before the file. `-n` gives numeric values. Flags such as `-G` change the tag names and so the field names. |

```ts
{ fs: { fileInfo: { timeout: 10000, args: ['-n', '-ee'] } } }
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `FileInfoService` | `FileInfoService`, singleton | `DefaultFileInfo` | none in this package | Replace: `DI.register(MyService).as(FileInfoService)` (last registration wins). Extend: subclass `DefaultFileInfo` and override a protected step. |

### Protected steps of `DefaultFileInfo`

| Member | Override to |
| --- | --- |
| `binaryPath()` | Pick the binary another way. |
| `spawnExif(binary, args)` | Run the process differently, eg. inside a container, or stub it in tests. |
| `runExifTool(fileArg, input?)` | Change the whole invocation. |
| `parseMetadata(raw)` | Parse another output format, eg. `-json`. |
| `toFileInfo(metadata)` | Change or add fields of the result. |

### `FileInfoService`: custom implementation without `exiftool`

Replace the service where `exiftool` cannot run, eg. a slim container without Perl. This one reads size and dates from `stat` and the MIME type from the extension.

```ts sample
import { stat } from 'fs/promises';
import { extname } from 'path';
import { DateTime } from 'luxon';
import { DI, Injectable } from '@spinajs/di';
import { IOFail } from '@spinajs/exceptions';
import { FileInfoService, getFs, IFileInfo } from '@spinajs/fs';

const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain',
};

@Injectable(FileInfoService)
export class StatFileInfo extends FileInfoService {
  public async getInfo(pathToFile: string): Promise<IFileInfo> {
    try {
      const info = await stat(pathToFile);
      return {
        FileSize: info.size,
        MimeType: MIME_TYPES[extname(pathToFile).toLowerCase()] ?? 'application/octet-stream',
        CreationDate: DateTime.fromJSDate(info.birthtime),
        ModificationDate: DateTime.fromJSDate(info.mtime),
        AccessDate: DateTime.fromJSDate(info.atime),
      };
    } catch (err) {
      throw new IOFail(`Cannot read info of ${pathToFile}`, err);
    }
  }

  public async getInfoFromStream(stream: NodeJS.ReadableStream): Promise<IFileInfo> {
    let size = 0;
    for await (const chunk of stream) {
      size += chunk.length;
    }
    return { FileSize: size, MimeType: 'application/octet-stream' };
  }
}

export function useStatFileInfo(): void {
  DI.register(StatFileInfo).as(FileInfoService);
}

export async function describeAttachment(path: string): Promise<string> {
  const info = await getFs('attachments').metadata(path);
  return `${info.MimeType}, ${info.FileSize} bytes`;
}
```

Importing the module registers `StatFileInfo` after `DefaultFileInfo`, so it wins; `useStatFileInfo()` does the same explicitly. Register it at startup, before code reads metadata.

### Extending `DefaultFileInfo`: add an orientation field

Subclass the default to keep `exiftool` and add derived fields.

```ts sample
import { DateTime } from 'luxon';
import { Injectable } from '@spinajs/di';
import { DefaultFileInfo, FileInfoService, IFileInfo } from '@spinajs/fs';

@Injectable(FileInfoService)
export class ImageFileInfo extends DefaultFileInfo {
  protected toFileInfo(metadata: Record<string, string | number | DateTime>): IFileInfo {
    const info = super.toFileInfo(metadata);

    if (typeof info.Width === 'number' && typeof info.Height === 'number' && info.Height > 0) {
      info.AspectRatio = Math.round((info.Width / info.Height) * 100) / 100;
      info.Orientation = info.Width >= info.Height ? 'landscape' : 'portrait';
    }

    return info;
  }
}
```

## File type checks

`isOfType(path, extension)` and `isOfMimetype(path, mimetype)` detect the type of a local file from its content with the `file-type` package, not from its name.

- A mismatch throws `IOFail` naming the requested and detected type.
- A type `file-type` cannot detect throws `IOFail` too. Plain text is one: `isOfType('notes.txt', 'txt')` fails.
- `_isOfType()` and `_isOfMimetype()` return a function that runs the check later.

## Important behaviour

- `FileSize` starts at `0` and is overwritten by the `fileSize` tag; with `-n` removed from `args` it may be a string like `"12 kB"`.
- `IFileInfo` accepts any field (`[key: string]: unknown`), so custom fields need no type change.
- `getInfo()` takes an absolute local path. `fsTemp.metadata()` forwards to the backend; remote providers download first.
- A `Raw` tag in the output cannot overwrite `Raw`: it is set last.

## Best practices

- Check uploads with `isOfMimetype()` before storing them; the client-sent MIME type and file name are not proof.
- Lower `fs.fileInfo.timeout` on request paths so a slow file cannot hold a request for 30 seconds.
- Read well-known fields (`Width`, `Duration`) rather than raw tag names; aliases stay stable across file formats.

## Examples

### Accept only PNG avatars up to 1024 px

```ts sample
import { isOfMimetype, getFs } from '@spinajs/fs';
import { InvalidArgument } from '@spinajs/exceptions';

export async function acceptAvatar(localUploadPath: string, userId: number): Promise<void> {
  await isOfMimetype(localUploadPath, 'image/png');

  const avatars = getFs('avatars');
  await avatars.upload(localUploadPath, `${userId}.png`);

  const info = await avatars.metadata(`${userId}.png`);
  if ((info.Width ?? 0) > 1024 || (info.Height ?? 0) > 1024) {
    await avatars.rm(`${userId}.png`);
    throw new InvalidArgument('Avatar must be at most 1024x1024 pixels');
  }
}
```

## Related

- [File operations](02-file-operations.md): `metadata()` on every provider.
- [CLI commands](11-cli-commands.md): `fs-info` prints the result.
