const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Estimated entropy of a random id: uuid v4 122 (any other uuid 0: v1 and v7 are not random), hex 4 bits a character, base64url 6 bits a character, anything else 0. */
export function idBits(id: string): number {
  if (UUID.test(id)) return UUID_V4.test(id) ? 122 : 0;
  if (/^[0-9a-f]+$/i.test(id)) return 4 * id.length;
  if (/^[A-Za-z0-9_-]+$/.test(id)) return 6 * id.length;
  return 0;
}
