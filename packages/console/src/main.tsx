import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Console } from '@appliance.sh/app';
import '@appliance.sh/app/styles.css';
import { webHost } from './host';

const container = document.getElementById('root');
if (!container) throw new Error('#root element not found');

createRoot(container).render(
  <StrictMode>
    <Console host={webHost} />
  </StrictMode>
);
