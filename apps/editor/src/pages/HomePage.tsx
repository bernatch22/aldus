import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type DocMeta } from '../lib/api';

const fmtSize = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

export function HomePage() {
  const [docs, setDocs] = useState<DocMeta[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api.list().then(setDocs).catch(e => setError(e.message));
  }, []);

  const uploadFile = useCallback(async (file: File) => {
    setBusy(true);
    setError('');
    try {
      const meta = await api.upload(file);
      navigate(`/doc/${meta.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo subir');
      setBusy(false);
    }
  }, [navigate]);

  return (
    <div className="home">
      <header className="home-head">
        <h1>Aldus</h1>
        <p>Edición pixel-perfect del grafo de contenido de un PDF.</p>
      </header>

      <div
        className={`dropzone${dragging ? ' dragging' : ''}`}
        onClick={() => fileRef.current?.click()}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files[0];
          if (f) void uploadFile(f);
        }}
      >
        {busy ? 'Subiendo…' : 'Arrastrá un PDF acá, o hacé click para elegirlo'}
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf"
          hidden
          onChange={e => { const f = e.target.files?.[0]; if (f) void uploadFile(f); }}
        />
      </div>

      {error && <p className="error">{error}</p>}

      {docs.length > 0 && (
        <ul className="doc-list">
          {docs.map(d => (
            <li key={d.id}>
              <Link to={`/doc/${d.id}`}>
                <span className="doc-name">{d.name}</span>
                <span className="doc-meta">{fmtSize(d.size)} · {new Date(d.uploadedAt).toLocaleString()}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
