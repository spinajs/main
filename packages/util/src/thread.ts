
/**
 * 
 * Sleep for a given duration in ms
 * 
 * @param duration sleep duration in ms
 * @returns 
 */
export const sleep = (duration: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, duration);
  });
};

/**
 * Delay execution of a function for a given duration
 */
export const delay = <T>(duration: number, callback: () => T) => {
  return new Promise<T>((resolve, reject) => {
    setTimeout(() => {
      try {
        const result = callback();

        if (result instanceof Promise) {
          result.then(resolve).catch(reject);
          return;
        }

        resolve(result);
      } catch (e) {
        reject(e);
      }
    }, duration);
  });

}
