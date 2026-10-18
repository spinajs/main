export class ComputedMembers {
  public *[Symbol.iterator](): Iterator<number> {
    yield 1;
  }

  public list(): number[] {
    return [];
  }
}
