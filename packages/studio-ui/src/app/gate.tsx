import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@coderush/ckit-components/empty';
import { Link } from '@coderush/ckit-components/link';
import type { ReactNode } from 'react';
import type { StudioFeature } from '../api/types';
import { useCapabilities, type Requirement } from './capabilities';

const HINTS: Record<StudioFeature, string> = {
  traces: 'No span reaches Studio. Enable tracing, or register StudioSpanProcessor in your OpenTelemetry SDK.',
  logs: 'Studio receives no log lines. Register StudioLogTarget as a log target.',
  slowQueries: 'Turn on db.Explain.Enabled to capture slow queries and their plans.',
  di: 'The app exposes no DI introspection to Studio.',
  routes: 'The app registers no HTTP controllers.',
  authz: 'Install @spinajs/authz to inspect the authorization model.',
  rebac: 'Register a TupleStore (@spinajs/authz-rebac) to inspect relations and tuples.',
  telemetry: 'Install @spinajs/telemetry for request statistics.',
  scheduler: 'Install @spinajs/scheduler-http to inspect scheduler runs.',
};

function NotAvailable({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {children ? <EmptyContent>{children}</EmptyContent> : null}
    </Empty>
  );
}

export function Gate({ feature, permission, label, children }: Requirement & { label: string; children: ReactNode }) {
  const capabilities = useCapabilities();
  if (feature && !capabilities.features[feature]) return <NotAvailable title={`${label} is not available`} description={HINTS[feature]} />;
  if (permission && !capabilities.permissions.includes(permission)) {
    return <NotAvailable title={`${label} needs ${permission}`} description={`Grant ${permission} to your principal in the Studio access domain.`} />;
  }
  return children;
}

export function NotFound() {
  return (
    <NotAvailable title="Page not found" description="Nothing in Studio lives at this address.">
      <Link href="/">Back to the overview</Link>
    </NotAvailable>
  );
}
