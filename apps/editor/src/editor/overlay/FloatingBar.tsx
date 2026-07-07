/**
 * FloatingBar — toolbar flotante arriba del segmento seleccionado: alineación
 * (relativa a la página), B/I/subrayado, familia, tamaño, color, lista, resaltar
 * (+color), link, eliminar. Con el editor abierto, el estilo/color/alineación
 * van A LA SELECCIÓN vía el evento SELECTION_STYLE_EVENT (el TextEditLayer los
 * aplica en vivo); cerrado, van al segmento entero por el modelo.
 */
import { useEffect, useState } from 'react';
import {
  effectiveGeometry,
  hasListMarker,
  originalStyledRuns,
  styledText,
  toggleListMarker,
  type FontBucket,
  type HighlightPatch,
  type SegmentEdit,
  type SegmentNode,
  type SegmentPatch,
  type StyledRun,
} from '@aldus/core';
import type { SavedHighlight } from './types';
import { AlignLeft, AlignCenter, AlignRight, Bold, Italic, Underline, Highlighter, Link2, List, Trash2 } from 'lucide-react';
import {
  activeEditingBox,
  applyAlign,
  dominantRun,
  family,
  measureWidth,
  round1,
  selectionStyle,
  SELECTION_STYLE_EVENT,
} from '../styledDom';
import { FbBtn, FbSep, FloatingWrap } from './toolbar';
import { liveEditRuns, styleAtRange } from './TextEditLayer';

/** Toolbar flotante arriba del segmento seleccionado: alineación (relativa a
 *  la página), B/I, resaltar (+color), link, eliminar. */
export function FloatingBar({ seg, edit, rect, pageWidth, frameWpt, onPatch, onDocOp, onRequestLink, savedHighlights, hasPendingHighlight, onHighlightPatch, highlightColor, onHighlightColor }: {
  seg: SegmentNode;
  edit: SegmentEdit | null;
  rect: { left: number; top: number };
  pageWidth: number;
  /** Ancho del ÁREA (pt) — el frame dentro del cual se alinea el texto. */
  frameWpt: number;
  onPatch: (patch: SegmentPatch) => void;
  onDocOp: (action: string, params: Record<string, unknown>) => void;
  onRequestLink: (target: { page: number; x: number; y: number; width: number; height: number }) => void;
  /** Resaltados GUARDADOS pegados a este segmento: quitar (toggle) recolorea a
   *  TODOS (un texto suele tener uno; si hay varios apilados, un clic los
   *  limpia). */
  savedHighlights: SavedHighlight[] | null;
  /** El segmento tiene un resaltado PENDIENTE (aún sin Aplicar). */
  hasPendingHighlight: boolean;
  onHighlightPatch: (hlId: string, patch: HighlightPatch) => void;
  highlightColor: string;
  onHighlightColor: (c: string) => void;
}) {
  const gluedHls = savedHighlights ?? [];
  const gluedTop = gluedHls[0] ?? null;
  const highlighted = !!gluedTop || hasPendingHighlight;
  const patchAllHls = (patch: HighlightPatch) => gluedHls.forEach(h => onHighlightPatch(h.id, patch));
  const styled: StyledRun[] = edit?.runs ?? originalStyledRuns(seg);
  // Con el editor abierto, B/I reflejan el estilo BAJO LA SELECCIÓN (no el del
  // segmento entero) y el toggle aplica solo a esa parte.
  const [selSty, setSelSty] = useState<{ bold: boolean; italic: boolean; underline?: boolean } | null>(null);
  useEffect(() => {
    const update = () => {
      const el = activeEditingBox();
      // El editor es un TEXTAREA: el estilo bajo el caret/selección se lee de
      // los runs VIVOS de la sesión + los offsets planos del textarea.
      if (el instanceof HTMLTextAreaElement && liveEditRuns) {
        setSelSty(styleAtRange(liveEditRuns, el.selectionStart, el.selectionEnd));
        return;
      }
      setSelSty(el ? selectionStyle(el, seg, edit) : null);
    };
    update();
    document.addEventListener('selectionchange', update);
    return () => document.removeEventListener('selectionchange', update);
  }, [seg, edit]);
  const allBold = selSty ? selSty.bold : styled.length > 0 && styled.every(r => r.bold);
  const allItalic = selSty ? selSty.italic : styled.length > 0 && styled.every(r => r.italic);
  const allUnderline = selSty ? !!selSty.underline : styled.length > 0 && styled.every(r => !!r.underline);
  const toggle = (key: 'bold' | 'italic' | 'underline') => {
    const el = activeEditingBox();
    if (el) {
      // dispatchEvent es SÍNCRONO: el layer ya mutó los runs — refrescar el
      // estado del botón al toque.
      window.dispatchEvent(new CustomEvent(SELECTION_STYLE_EVENT, { detail: { key } }));
      if (el instanceof HTMLTextAreaElement && liveEditRuns) {
        setSelSty(styleAtRange(liveEditRuns, el.selectionStart, el.selectionEnd));
      }
      return;
    }
    const next = key === 'bold' ? !allBold : key === 'italic' ? !allItalic : !allUnderline;
    onPatch({ runs: styled.map(r => ({ ...r, [key]: next })) });
  };
  const eff = effectiveGeometry(seg, edit);
  // Alinear el TEXTO dentro del área (no mover el nodo): con el editor abierto
  // va por evento al layer (display en vivo); si no, se recalcula el dx de cada
  // línea acá con applyAlign (frame = ancho del área).
  const curAlign: 'left' | 'center' | 'right' = edit?.align ?? 'left';
  const setAlign = (a: 'left' | 'center' | 'right') => {
    if (activeEditingBox()) {
      window.dispatchEvent(new CustomEvent(SELECTION_STYLE_EVENT, { detail: { key: 'align', align: a } }));
      return;
    }
    const base = edit?.runs ?? originalStyledRuns(seg);
    const aligned = applyAlign(base, seg, 1, frameWpt, a);
    onPatch({ align: a === 'left' ? null : a, runs: a === 'left' && !edit?.runs ? undefined : aligned });
  };
  // El highlight lleva el segmentId: si después movés el texto, el resaltado
  // LO SIGUE (se resuelve contra la geometría efectiva al previsualizar/aplicar).
  const bbox = { page: seg.page, segmentId: seg.id, x: eff.x, y: eff.y, width: eff.width, height: eff.height };

  const dom = dominantRun(seg);
  const textColor = edit?.color ?? dom.color ?? '#000000';
  const effSize = edit?.fontSize ?? seg.fontSize;
  // Con el editor abierto, el color va a la SELECCIÓN (por tramo); si no, al
  // segmento entero (override clásico).
  const applyColor = (v: string) => {
    if (activeEditingBox()) {
      window.dispatchEvent(new CustomEvent(SELECTION_STYLE_EVENT, { detail: { key: 'color', color: v } }));
      return;
    }
    onPatch({ color: v.toLowerCase() === (dom.color ?? '#000000').toLowerCase() ? null : v });
  };

  // Lista = un FORMATO más del texto: toggle del marcador "•  " al frente
  // (Enter en edición continúa la lista con el marcador incrementado).
  // Con el editor ABIERTO, el toggle va por evento al TextEditLayer (muta el
  // textarea en vivo — mismo principio que B/I/color). Cerrado: por el modelo.
  const [, bumpListTick] = useState(0);
  const liveBox = activeEditingBox();
  const liveText = liveBox instanceof HTMLTextAreaElement ? liveBox.value : liveBox?.textContent;
  const isList = hasListMarker(liveText ?? styledText(styled));
  const toggleList = () => {
    if (activeEditingBox()) {
      window.dispatchEvent(new CustomEvent(SELECTION_STYLE_EVENT, { detail: { key: 'list' } }));
      bumpListTick(t => t + 1); // refresca el estado del botón
      return;
    }
    const next = toggleListMarker(styled);
    if (next !== styled) {
      // VIÑETA COLGANTE (Word/Acrobat): el CONTENIDO no se mueve — la viñeta
      // cuelga a la izquierda (x se corre el ancho del marcador) y el texto
      // queda alineado con el resto del documento.
      const before = styledText(styled);
      const after = styledText(next);
      const adding = after.length > before.length;
      const markerText = adding ? after.slice(0, after.length - before.length) : before.slice(0, before.length - after.length);
      const mw = measureWidth(markerText, `${seg.fontSize}px ${family(dominantRun(seg))}`);
      const nx = round1(Math.max(4, eff.x + (adding ? -mw : mw)));
      onPatch({ runs: next, text: after, x: nx === round1(seg.x) ? null : nx });
    }
  };

  return (
    <FloatingWrap rect={rect}>
      <FbBtn label="Negrita" onClick={() => toggle('bold')} active={allBold}><Bold size={14} /></FbBtn>
      <FbBtn label="Itálica" onClick={() => toggle('italic')} active={allItalic}><Italic size={14} /></FbBtn>
      <FbBtn label="Subrayado" onClick={() => toggle('underline')} active={allUnderline}><Underline size={14} /></FbBtn>
      <FbBtn label="Lista con viñeta (Enter en edición agrega el siguiente ítem)" onClick={toggleList} active={isList}><List size={14} /></FbBtn>
      <select
        className="fb-input"
        style={{ width: 76 }}
        title="Familia tipográfica"
        value={edit?.font ?? 'original'}
        onMouseDown={e => e.stopPropagation()}
        onClick={e => e.stopPropagation()}
        onChange={e => onPatch({ font: e.target.value === 'original' ? null : (e.target.value as FontBucket) })}
      >
        <option value="original">Original</option>
        <option value="sans">Sans</option>
        <option value="serif">Serif</option>
        <option value="mono">Mono</option>
      </select>
      <input
        className="fb-input"
        type="number"
        step={0.5}
        min={4}
        title="Tamaño (pt)"
        key={`${seg.id}-${round1(effSize)}`}
        defaultValue={round1(effSize)}
        onMouseDown={e => e.stopPropagation()}
        onClick={e => e.stopPropagation()}
        onBlur={e => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v) && v >= 4) onPatch({ fontSize: round1(v) === round1(seg.fontSize) ? null : round1(v) });
        }}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
      <button className="fb-swatch" title="Color del texto (a la selección si estás editando)" style={{ background: textColor }} onMouseDown={e => e.preventDefault()} onClick={e => e.stopPropagation()}>
        <input type="color" value={textColor} onChange={e => applyColor(e.target.value)} />
      </button>
      <FbSep />
      <FbBtn label="Texto a la izquierda del área" active={curAlign === 'left'} onClick={() => setAlign('left')}><AlignLeft size={14} /></FbBtn>
      <FbBtn label="Centrar el texto en el área (ensanchá con el grip)" active={curAlign === 'center'} onClick={() => setAlign('center')}><AlignCenter size={14} /></FbBtn>
      <FbBtn label="Texto a la derecha del área" active={curAlign === 'right'} onClick={() => setAlign('right')}><AlignRight size={14} /></FbBtn>
      <FbSep />
      {/* Resaltar: si el segmento YA tiene un highlight guardado pegado, el
          botón lo QUITA (toggle, como Word/Acrobat) y el swatch lo RECOLOREA —
          nunca apila otra anotación encima. Si no, crea uno nuevo. */}
      <FbBtn
        label={highlighted ? (gluedHls.length > 1 ? `Quitar el resaltado (${gluedHls.length} apilados)` : 'Quitar el resaltado') : 'Resaltar (acumula, se escribe con Aplicar)'}
        active={highlighted}
        onClick={() => {
          if (highlighted) { patchAllHls({ remove: true }); onDocOp('unhighlight', { segmentId: seg.id }); } // quita guardados + pendientes
          else onDocOp('highlight', { ...bbox, color: highlightColor });
        }}
      ><Highlighter size={14} /></FbBtn>
      <button className="fb-swatch" title={gluedTop ? 'Color del resaltado (recolorea el existente)' : 'Color del resaltador'} style={{ background: gluedTop?.color ?? highlightColor }} onMouseDown={e => e.preventDefault()} onClick={e => e.stopPropagation()}>
        <input type="color" value={gluedTop?.color ?? highlightColor} onChange={e => (gluedTop ? patchAllHls({ color: e.target.value }) : onHighlightColor(e.target.value))} />
      </button>
      <FbBtn label="Link" onClick={() => onRequestLink(bbox)}><Link2 size={14} /></FbBtn>
      <FbSep />
      <FbBtn label="Eliminar" onClick={() => onPatch({ remove: true })} danger><Trash2 size={14} /></FbBtn>
    </FloatingWrap>
  );
}
