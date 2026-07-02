/**
 * dialogs.tsx — los modales que reemplazan a window.prompt/confirm/alert.
 * Header/Footer, Watermark y Link, con inputs de verdad.
 */

import { useState } from 'react';
import { Button, FieldLabel, Modal } from './primitives';

export function WatermarkDialog({ onClose, onApply }: { onClose: () => void; onApply: (text: string) => void }) {
  const [text, setText] = useState('BORRADOR');
  const submit = () => { if (text.trim()) onApply(text.trim()); onClose(); };
  return (
    <Modal
      title="Marca de agua"
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" onClick={submit}>Aplicar</Button></>}
    >
      <div>
        <FieldLabel>Texto (diagonal, en todas las páginas)</FieldLabel>
        <input
          autoFocus
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit(); }}
          className="h-9 w-full rounded-md border border-neutral-200 px-3 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-100"
        />
      </div>
    </Modal>
  );
}

export function HeaderFooterDialog({ onClose, onApply }: { onClose: () => void; onApply: (v: { header?: string; footer?: string; pageNumbers: boolean }) => void }) {
  const [header, setHeader] = useState('');
  const [footer, setFooter] = useState('');
  const [pageNumbers, setPageNumbers] = useState(true);
  const submit = () => {
    if (header.trim() || footer.trim() || pageNumbers) {
      onApply({ header: header.trim() || undefined, footer: footer.trim() || undefined, pageNumbers });
    }
    onClose();
  };
  const inputCls = 'h-9 w-full rounded-md border border-neutral-200 px-3 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-100';
  return (
    <Modal
      title="Encabezado y pie de página"
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" onClick={submit}>Aplicar</Button></>}
    >
      <div>
        <FieldLabel>Encabezado</FieldLabel>
        <input autoFocus value={header} onChange={e => setHeader(e.target.value)} placeholder="(opcional)" className={inputCls} />
      </div>
      <div>
        <FieldLabel>Pie de página</FieldLabel>
        <input value={footer} onChange={e => setFooter(e.target.value)} placeholder="(opcional)" className={inputCls} />
      </div>
      <label className="flex items-center gap-2 text-[13px] text-neutral-700">
        <input type="checkbox" checked={pageNumbers} onChange={e => setPageNumbers(e.target.checked)} className="h-4 w-4 rounded border-neutral-300 accent-blue-600" />
        Numerar páginas <span className="text-neutral-400">(Página N de M, abajo a la derecha)</span>
      </label>
    </Modal>
  );
}

export function LinkDialog({ onClose, onApply }: { onClose: () => void; onApply: (url: string) => void }) {
  const [url, setUrl] = useState('https://');
  const valid = /^https?:\/\/.+\..+/.test(url.trim());
  const submit = () => { if (valid) { onApply(url.trim()); onClose(); } };
  return (
    <Modal
      title="Convertir en link"
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" disabled={!valid} onClick={submit}>Crear link</Button></>}
    >
      <div>
        <FieldLabel>URL de destino</FieldLabel>
        <input
          autoFocus
          value={url}
          onChange={e => setUrl(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit(); }}
          className="h-9 w-full rounded-md border border-neutral-200 px-3 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-100"
        />
      </div>
    </Modal>
  );
}
