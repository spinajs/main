
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
