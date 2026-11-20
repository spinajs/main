/** @spinajs query selct */
export class Misspelled<T> {
  constructor(readonly row: T) {}
}

export class Below<T> extends Misspelled<T> {}
export declare const below: Below<number>;
