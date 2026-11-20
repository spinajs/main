import { ReactRouterAdapter } from '@coderush/ckit-components/react-router';
import { ThemeProvider } from '@coderush/ckit-components/theme';
import { Route, Routes } from 'react-router';
import { CapabilitiesProvider } from './capabilities';
import { Gate, NotFound } from './gate';
import { pages } from './pages';
import { AppLayout } from './shell';

/** Rendered inside a router: `BrowserRouter` with the Studio base in the app, `MemoryRouter` in tests. */
export function App() {
  return (
    <ThemeProvider mode="system" brand="indigo" neutral="zinc" density="compact" storageKey="spina-studio-theme">
      <ReactRouterAdapter>
        <CapabilitiesProvider>
          <Routes>
            <Route element={<AppLayout />}>
              {pages.map((page) => (
                <Route
                  key={page.path}
                  path={page.path}
                  element={
                    <Gate feature={page.feature} permission={page.permission} label={page.label}>
                      {page.element}
                    </Gate>
                  }
                />
              ))}
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </CapabilitiesProvider>
      </ReactRouterAdapter>
    </ThemeProvider>
  );
}
