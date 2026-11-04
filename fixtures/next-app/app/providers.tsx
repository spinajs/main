'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { createAppClient } from '../generated/client';
import type { AppClientProvider } from '../generated/client.react';

export function Providers({ apiUrl, provider: Provider, children }: { apiUrl: string; provider: typeof AppClientProvider; children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 60_000 } } }));
  const [client] = useState(() => createAppClient({ baseUrl: apiUrl }));
  return (
    <QueryClientProvider client={queryClient}>
      <Provider client={client}>{children}</Provider>
    </QueryClientProvider>
  );
}
