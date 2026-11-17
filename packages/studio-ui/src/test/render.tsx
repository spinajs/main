import { QueryClient } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { App } from '../app/App';
import { QueryProvider } from '../app/query-provider';
import { fakeApi, type FakeRoutes } from './fake-api';
import { capabilities } from './fixtures';

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

/** The whole app at `path`, over a fake server answering `routes` (capabilities included unless overridden) and an empty query cache. */
export function renderStudio(path: string, { capabilities: caps = capabilities, routes = {} }: { capabilities?: unknown; routes?: FakeRoutes } = {}) {
  const api = fakeApi({ 'GET /_studio/api/capabilities': caps, ...routes });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <QueryProvider client={client}>
        <App />
      </QueryProvider>
      <LocationProbe />
    </MemoryRouter>,
  );
  return { ...view, api, location: () => view.getByTestId('location').textContent ?? '' };
}
