import React from 'react';
import { createRoot } from 'react-dom/client';
import { Aura } from './Aura';
import './aura.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Aura />
  </React.StrictMode>,
);
