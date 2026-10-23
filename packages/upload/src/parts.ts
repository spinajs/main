export function partCountOf(size: number, partSize: number): number {
  return Math.ceil(size / partSize);
}

/** `partSize`, or the remainder for the last part (spec §4.1). */
export function expectedPartSize(size: number, partSize: number, part: number): number {
  const last = partCountOf(size, partSize);
  return part < last ? partSize : size - partSize * (last - 1);
}

export function missingParts(partCount: number, received: Iterable<number>): number[] {
  const have = new Set(received);
  const missing: number[] = [];
  for (let n = 1; n <= partCount; n++) {
    if (!have.has(n)) missing.push(n);
  }
  return missing;
}

/** Bytes in the run of stored parts from part 1; a sequential client resumes there (spec §3). */
export function contiguousOffset(size: number, partSize: number, received: Iterable<number>): number {
  const have = new Set(received);
  const count = partCountOf(size, partSize);
  let offset = 0;
  for (let n = 1; n <= count && have.has(n); n++) {
    offset += expectedPartSize(size, partSize, n);
  }
  return offset;
}
