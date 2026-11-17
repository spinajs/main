import { createContext, use, type ReactNode } from 'react';
import { fetchCapabilities } from '../api/client';
import { studioKeys, useStudioQuery } from '../api/query';
import type { StudioCapabilities, StudioFeature } from '../api/types';
import { Loading, PageError } from '../components/page';

export const CapabilitiesContext = createContext<StudioCapabilities | null>(null);

export function CapabilitiesProvider({ children }: { children: ReactNode }) {
  const { data, error } = useStudioQuery(studioKeys.capabilities, fetchCapabilities);
  if (error) return <PageError error={error} />;
  if (!data) return <Loading label="Connecting to Studio" />;
  return <CapabilitiesContext value={data}>{children}</CapabilitiesContext>;
}

export function useCapabilities(): StudioCapabilities {
  const capabilities = use(CapabilitiesContext);
  if (!capabilities) throw new Error('useCapabilities needs a CapabilitiesProvider');
  return capabilities;
}

export interface Requirement {
  feature?: StudioFeature;
  permission?: string;
}

export const canOpen = (capabilities: StudioCapabilities, { feature, permission }: Requirement): boolean =>
  (feature === undefined || capabilities.features[feature]) && (permission === undefined || capabilities.permissions.includes(permission));
