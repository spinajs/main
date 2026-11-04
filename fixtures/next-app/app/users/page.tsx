import { dehydrate, HydrationBoundary, QueryClient } from '@tanstack/react-query';
import { headers } from 'next/headers';
import { createNextServerAppClient } from '../../generated/client.next';
import { appQueries } from '../../generated/client.queries';
import { apiUrl } from '../api-url';
import { createUser } from './actions';
import { UsersList } from './users-list';

export default async function UsersPage() {
  const client = createNextServerAppClient({ baseUrl: apiUrl(), incoming: await headers(), revalidate: 3600 });
  const queryClient = new QueryClient();
  await queryClient.prefetchQuery(appQueries.users.list(client, { query: {} }));
  return (
    <main>
      <HydrationBoundary state={dehydrate(queryClient)}>
        <UsersList />
      </HydrationBoundary>
      <form action={createUser}>
        <input name="email" type="email" required />
        <button type="submit">Add</button>
      </form>
    </main>
  );
}
