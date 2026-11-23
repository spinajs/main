import 'virtual:ckit.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import './app/studio.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { studioBase } from './api/base';
import { App } from './app/App';
import { QueryProvider } from './app/query-provider';

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root element');

createRoot(root).render(
  <StrictMode>
    <BrowserRouter basename={studioBase()}>
      <QueryProvider>
        <App />
      </QueryProvider>
    </BrowserRouter>
  </StrictMode>,
);
