import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { UploadCloud, FileText, ChevronRight } from 'lucide-react';
import { aldusApi as api } from '../src/react/AldusEditor.js';
import type { DocMeta } from '../src/core/index.js';

const fmtSize = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

export function HomePage() {
  const [docs, setDocs] = useState<DocMeta[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => { api.list().then(setDocs).catch(e => setError(e.message)); }, []);

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
    <div className="mx-auto max-w-2xl px-6 py-16">
      <header className="mb-8 flex items-center gap-3">
        <span
          className="grid h-11 w-11 place-items-center bg-blue-600 text-lg font-bold text-white"
          style={{ clipPath: 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)' }}
        >A</span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">Aldus</h1>
          <p className="text-[13px] text-neutral-500">Edición pixel-perfect del grafo de contenido de un PDF.</p>
          <p className="text-[11px] italic text-neutral-400">God's in his heaven. All's right with the PDF.</p>
        </div>
      </header>

      <div
        onClick={() => fileRef.current?.click()}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) void uploadFile(f); }}
        className={`flex cursor-pointer flex-col items-center gap-3 rounded-2xl border-2 border-dashed px-6 py-14 text-center transition-colors ${dragging ? 'border-blue-500 bg-blue-50' : 'border-neutral-200 bg-white hover:border-blue-300 hover:bg-neutral-50'}`}
      >
        <UploadCloud size={32} strokeWidth={1.6} className="text-neutral-400" />
        <span className="text-[14px] font-medium text-neutral-600">{busy ? 'Subiendo…' : 'Arrastrá un PDF o hacé click para elegirlo'}</span>
        <input ref={fileRef} type="file" accept="application/pdf" hidden onChange={e => { const f = e.target.files?.[0]; if (f) void uploadFile(f); }} />
      </div>

      {error && <p className="mt-4 text-[13px] text-red-600">{error}</p>}

      {docs.length > 0 && (
        <ul className="mt-8 space-y-2">
          {docs.map(d => (
            <li key={d.id}>
              <Link to={`/doc/${d.id}`} className="group flex items-center gap-3 rounded-xl border border-neutral-200 bg-white px-4 py-3 transition-colors hover:border-blue-300 hover:bg-neutral-50">
                <FileText size={18} className="shrink-0 text-neutral-400" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium text-neutral-800">{d.name}</span>
                  <span className="block text-[12px] text-neutral-400">{fmtSize(d.size)} · {new Date(d.uploadedAt).toLocaleString()}</span>
                </span>
                <ChevronRight size={16} className="shrink-0 text-neutral-300 group-hover:text-blue-500" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
