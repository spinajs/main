// foo.d.ts
declare module 'exiftool' {
  export function metadata(path: any, callback: (err: Error, metadata: any) => void): any;
}
