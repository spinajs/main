import { Effect } from 'effect';

export namespace Util {
  export namespace JSON {
    export class JsonError {
      readonly _tag = 'JsonError';

      constructor(public Reason: Error) {}
    }

    /**
     * Parse json to string
     *
     * @param json
     * @returns
     */
    export const parse = (json: string) => {
      return Effect.try({
        try: () => global.JSON.parse(json),
        catch: (error: Error) => new JsonError(error),
      });
    };

    /**
     *
     * Stringifies object to string
     *
     * @param object object to stringify
     * @returns
     */
    export const stringify = (object: unknown) => {
      return Effect.try({
        try: () => global.JSON.stringify(object),
        catch: (error: Error) => new JsonError(error),
      });
    };
  }
}
