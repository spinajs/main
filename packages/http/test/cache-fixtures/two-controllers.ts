/** The first controller. */
export class FirstController {
  /** Lists the items of a page. */
  public list(page: number): number {
    return page;
  }
}

/** The second controller. */
export class SecondController {
  /** Reads one item. */
  public get(id: string): string {
    return id;
  }
}
