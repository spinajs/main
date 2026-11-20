import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { withStatus } from '../test/fake-api';
import { renderStudio } from '../test/render';

// The first render of the whole shell in a file is the slow one: on a loaded machine it took 5.6 s, past Vitest's
// 5 s default, while the later cases, rendering the same shell, passed within it.
const SHELL = { timeout: 15_000 };

describe('Studio shell', { timeout: 30_000 }, () => {
  it('lists the pages in sidebar sections and opens the overview', async () => {
    renderStudio('/');
    const observe = await screen.findByRole('group', { name: 'Observe' }, SHELL);
    expect(within(observe).getByRole('link', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
  });

  it('explains a 403 from capabilities instead of rendering the shell', async () => {
    renderStudio('/', { capabilities: withStatus(403, { message: 'studio:read required' }) });
    const alert = await screen.findByRole('alert', {}, SHELL);
    expect(alert).toHaveTextContent('Access denied');
    expect(alert).toHaveTextContent('studio:read required');
    expect(screen.queryByRole('group', { name: 'Observe' })).not.toBeInTheDocument();
  });

  it('renders a not-found page for an unknown path', async () => {
    renderStudio('/nope');
    expect(await screen.findByText('Page not found', {}, SHELL)).toBeInTheDocument();
  });

  it('opens the command palette with Ctrl+K and lists the pages', async () => {
    renderStudio('/');
    await screen.findByRole('group', { name: 'Observe' }, SHELL);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Go to page' });
    expect(within(dialog).getByText('Overview')).toBeInTheDocument();
  });
});
