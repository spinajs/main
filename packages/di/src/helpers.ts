/**
 * Checks if value is constructable type.
 * Checks for [[Construct]] internal function in object.
 *
 * @param value - value to test
 */
export function isConstructor(value: any) {
  try {
    Reflect.construct(String, [], value);
  } catch (e) {
    return false;
  }

  return true;
}
