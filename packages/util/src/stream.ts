export namespace Util {
    export namespace Stream {
        export namespace Sink {

            export const filter = (predicate: (item: any) => Promise<boolean>) => {
                return (stream: Stream) => {
                    return new Chunk();
                }
            }

            export const leftover = (filtered: (stream: Stream) => Stream) => {
                return (source: Stream) => { }
            }

            export const take = (count: number) => {
                return (stream: Stream) => {
                    return new Chunk();

                }

            }

            export const skip = (count: number) => {
                return (stream: Stream) => {
                    return new Chunk();

                }
            }

            export class Stream {
                public static fromArray() {
                    return new Stream();
                }

                run(callback: (s: Stream) => any) { }
            }

            export class Chunk extends Stream {

            }


            const s = new Stream();

            s.run(leftover(take(5)));

        }
    }

}