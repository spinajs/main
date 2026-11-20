import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { capabilities, withFeatures } from '../test/fixtures';
import type { StudioCapabilities } from '../api/types';
import { CapabilitiesContext } from './capabilities';
import { Gate } from './gate';

const renderGate = (caps: StudioCapabilities, requirement: { feature?: 'di'; permission?: string }) =>
  render(
    <CapabilitiesContext value={caps}>
      <Gate label="DI graph" {...requirement}>
        <p>the graph</p>
      </Gate>
    </CapabilitiesContext>,
  );

describe('Gate', () => {
  it('renders the page when its feature and permission are there', () => {
    renderGate(capabilities, { feature: 'di', permission: 'studio:read' });
    expect(screen.getByText('the graph')).toBeInTheDocument();
  });

  it('explains a missing feature', () => {
    renderGate(withFeatures({ di: false }), { feature: 'di' });
    expect(screen.queryByText('the graph')).not.toBeInTheDocument();
    expect(screen.getByText('DI graph is not available')).toBeInTheDocument();
    expect(screen.getByText('The app exposes no DI introspection to Studio.')).toBeInTheDocument();
  });

  it('names a missing permission', () => {
    renderGate({ ...capabilities, permissions: ['studio:read'] }, { permission: 'studio:explain' });
    expect(screen.getByText('DI graph needs studio:explain')).toBeInTheDocument();
  });
});
