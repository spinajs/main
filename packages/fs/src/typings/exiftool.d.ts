// platform packages of exiftool-vendored - each default-exports the absolute
// path to the vendored exiftool binary. Only the package matching the current
// platform is installed ( .exe on windows, .pl elsewhere ).
declare module 'exiftool-vendored.exe' {
  const binaryPath: string;
  export default binaryPath;
}

declare module 'exiftool-vendored.pl' {
  const binaryPath: string;
  export default binaryPath;
}
