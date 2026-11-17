import { Alert, AlertDescription, AlertTitle } from '@coderush/ckit-components/alert';
import { Spinner } from '@coderush/ckit-components/spinner';
import type { ReactNode } from 'react';
import { ApiError } from '../api/client';

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="studio-page-header">
      <div>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="studio-actions">{actions}</div> : null}
    </header>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="studio-loading">
      <Spinner aria-hidden />
      <span>{`${label}…`}</span>
    </div>
  );
}

export function describeError(error: unknown): { title: string; message: string } {
  if (error instanceof ApiError) {
    if (error.status === 401) return { title: 'Not signed in', message: 'Sign in to the application, then reload Studio.' };
    if (error.status === 403) return { title: 'Access denied', message: error.message };
    if (error.status === 404) return { title: 'Not found', message: error.message };
    return { title: `The server answered ${error.status}`, message: error.message };
  }
  return { title: 'Studio could not load this', message: error instanceof Error ? error.message : String(error) };
}

export function PageError({ error }: { error: unknown }) {
  const { title, message } = describeError(error);
  return (
    <Alert variant="destructive" role="alert">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}
