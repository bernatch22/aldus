/** App de EJEMPLO (demo/) — router + upload. NUNCA se publica: la lib es
 *  `src/react/lib.ts` (sin react-router). */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, HashRouter, Route, Routes } from 'react-router-dom';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { HomePage } from './HomePage.js';
import { EditorPage } from './EditorRoute.js';
import '../src/styles.css';

GlobalWorkerOptions.workerSrc = workerUrl;

// basename SIN slash final: React Router v6 exige que la URL empiece por el
// basename, y "/aldus" (sin slash, la URL natural) NO empieza por "/aldus/" →
// no matchea y renderiza null (pantalla en blanco/negro). Sacando el slash
// final, "/aldus" matchea "/aldus" y "/aldus/". Con base "/" queda "".
const basename = import.meta.env.BASE_URL.replace(/\/+$/, '');

// VITE_ROUTER=hash → HashRouter (#/doc/:id): para servir el editor como bundle
// ESTÁTICO sin rewrites del server (un host embebedor tipo signwax deep-linkea
// /editor/#/doc/<id> y el archivo servido es siempre index.html).
const useHash = import.meta.env.VITE_ROUTER === 'hash';
const Router = useHash ? HashRouter : BrowserRouter;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Router {...(useHash ? {} : { basename })}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/doc/:id" element={<EditorPage />} />
      </Routes>
    </Router>
  </StrictMode>,
);
