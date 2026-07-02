import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { HomePage } from './pages/HomePage';
import { EditorPage } from './pages/EditorPage';
import './styles.css';

GlobalWorkerOptions.workerSrc = workerUrl;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/doc/:id" element={<EditorPage />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
