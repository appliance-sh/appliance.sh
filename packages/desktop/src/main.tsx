import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Console } from '@appliance.sh/app';
import '@appliance.sh/app/styles.css';
import { tauriHost } from './host';

const container = document.getElementById('root');
if (!container) throw new Error('#root element not found');

createRoot(container).render(
  <StrictMode>
    <Console host={tauriHost} />
  </StrictMode>
);
