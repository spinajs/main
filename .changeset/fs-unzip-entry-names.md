---
"@spinajs/fs": patch
---

Security: `fsNative.unzip()` no longer trusts `unzipper` to keep entries inside the destination. Before, `unzipper` versions 0.12.1 to 0.12.4, which the `^0.12.3` range allows, compared paths as strings, so an entry such as `../uploads-old/x.txt` extracted into `uploads` was written to `uploads-old/x.txt`, outside the destination. Version 0.12.5 dropped such entries silently and reported success. An archive with a dropped entry of 16 KiB or more, a NUL byte in a name, an entry written through a symbolic link entry, or an entry below another entry that is a file made `unzip()` hang forever, as did a destination that is an existing file. Such write failures now reject with `IOFail` naming the destination or the entry. And `unzip()` resolved before most entries of an archive with many entries were written; the rest never arrived (16 of 200 in the test).

`unzip()` now reads the archive's central directory and checks every entry before it writes any. An entry whose path resolves outside the destination, an absolute name, a symbolic link or other non-file entry, or a name the fs path rules refuse (a NUL byte, a segment holding `:` or ending in `.` or a space) makes the call reject with `IOFail` naming the entry, and nothing of that archive is written. Backslashes in entry names are read as separators on every platform.
