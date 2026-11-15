import type { ReactNode } from 'react';
import { AppClientProvider } from '../generated/client.react';
import { apiUrl } from './api-url';
import { Providers } from './providers';

// AppClientProvider is imported by this Server Component, so a client.react.ts without 'use client' fails `next build`.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers apiUrl={apiUrl()} provider={AppClientProvider}>
          {children}
        </Providers>
      </body>
    </html>
  );
}
