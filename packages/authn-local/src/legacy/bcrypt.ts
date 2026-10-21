import { compare } from 'bcryptjs';

// $2x$ is left out: bcryptjs does not read it.
const BCRYPT = /^\$2[aby]\$(?:0[4-9]|[12]\d|3[01])\$[./A-Za-z0-9]{53}$/;

export function isBcrypt(stored: string): boolean {
  return BCRYPT.test(stored);
}

export async function verifyBcrypt(stored: string, password: string): Promise<boolean> {
  try {
    return await compare(password, stored);
  } catch {
    return false;
  }
}
