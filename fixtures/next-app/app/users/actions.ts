'use server';
import { headers } from 'next/headers';
import { revalidateController } from '../../generated/client.next';
import { createServerAppClient } from '../../generated/client.server';
import { DEFAULT_FORWARDED_HEADERS } from '../../generated/runtime/index.js';
import { apiUrl } from '../api-url';

// The API's CSRF guard refuses a cookie-carrying POST without the browser's Origin; Next checked that Origin already.
export async function createUser(form: FormData): Promise<void> {
  const client = createServerAppClient({ baseUrl: apiUrl(), incoming: await headers(), forward: [...DEFAULT_FORWARDED_HEADERS, 'origin'] });
  await client.users.create({ email: String(form.get('email')) });
  revalidateController('users');
}
