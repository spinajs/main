---
"@spinajs/fs": patch
---

Security: `fsNative.unzip()` no longer trusts `unzipper` to keep entries inside the destination.

Before:

- `unzipper` versions 0.12.1 to 0.12.4, which the `^0.12.3` range allows, compared paths as strings. So an entry such as `../uploads-old/x.txt` extracted into `uploads` was written to `uploads-old/x.txt`, outside the destination.
- Version 0.12.5 dropped such entries silently and reported success.
- `unzip()` hung forever on an archive with a dropped entry of 16 KiB or more, a NUL byte in a name, an entry written through a symbolic link entry, or an entry below another entry that is a file. It also hung when the destination was an existing file.
- `unzip()` resolved before most entries of an archive with many entries were written, and the rest never arrived (16 of 200 in the test).
- Encrypted entries were written as their ciphertext.

`unzip()` now reads the archive's central directory and checks every entry before it writes any. The call rejects with `IOFail` naming the entry, and nothing of that archive is written, when an entry:

- resolves outside the destination;
- has an absolute name;
- is a symbolic link or another non-file entry;
- is encrypted or uses a compression method other than stored or deflate;
- has a name the fs path rules refuse (a NUL byte, a segment holding `:` or ending in `.` or a space).

Before each write it also checks real paths: an entry whose path is a link on disk, or whose nearest existing folder resolves outside the destination's real path, is refused. A link created inside the destination while the unzip runs is not covered.

A destination that is a file, an entry below a file entry, or a broken compressed stream now rejects with `IOFail` naming the destination or the entry. The failing entry's file is removed, and earlier entries stay extracted.

Backslashes in entry names are read as separators on every platform. An archive comment of any length is read. There is still no limit on the extracted size, and CRCs are not verified.
