export class Payload { id!: number }

type AsyncOf<T> = Promise<T>;
export interface ProbeRows {
  P: Promise<Payload>;
  A: AsyncOf<Payload>;
}
