/**
 * FloatingBar — toolbar flotante arriba del segmento seleccionado: alineación
 * (relativa a la página), B/I/subrayado, familia, tamaño, color, lista, resaltar
 * (+color), link, eliminar.
 *
 * TRANSPORTE v2 (audit §3.4): con el editor abierto, el estilo/color/alineación
 * van A LA SELECCIÓN vía `controller.applyStyle(...)` (llamada directa y
 * tipada) en vez del CustomEvent `SELECTION_STYLE_EVENT` de v1; el estado en
 * vivo (B/I/U bajo el caret, tipo de lista) se lee de `controller.styleState`/
 * `controller.selectionStyle` + la suscripción `onStyleStateChanged` — muere el
 * par `liveEditRuns`/`liveMarkerKind` (module-let). Cerrado, el estilo va al
 * segmento entero por el modelo — TODO ese camino es VERBATIM de v1 (medición
 * de marcadores, corrimiento de ancla, `withW` del subrayado).
 */
import { useEffect, useState } from 'react';
import {
  effectiveGeometry,
  hasListMarker,
  listMarkerLen,
  originalStyledRuns,
  styledText,
  toggleListMarker,
  type FontBucket,
  type ListKind,
  type HighlightPatch,
  type SegmentEdit,
  type SegmentNode,
  type SegmentPatch,
  type StyledRun,
} from '@aldus/core';
import { AlignLeft, AlignCenter, AlignRight, Bold, Italic, Underline, Highlighter, Link2, List, Trash2 } from 'lucide-react';
import {
  applyAlign,
  dominantRun,
  family,
  measureWidth,
  round1,
  type StyleState,
  type TextEditController,
} from '../core/index.js';
import type { SavedHighlight } from './boxes/types.js';
import { FbBtn, FbSep, FloatingWrap } from './toolbar.js';

/** Toolbar flotante arriba del segmento seleccionado: alineación (relativa a
 *  la página), B/I, resaltar (+color), link, eliminar. */
export function FloatingBar({ seg, edit, pageWidth, frameWpt, controller, onPatch, onDocOp, onRequestLink, savedHighlights, hasPendingHighlight, onHighlightPatch, highlightColor, onHighlightColor }: {
  seg: SegmentNode;
  edit: SegmentEdit | null;
  pageWidth: number;
  /** Ancho del ÁREA (pt) — el frame dentro del cual se alinea el texto. */
  frameWpt: number;
  /** EL editor de texto (singleton) — la barra le habla directo. */
  controller: TextEditController;
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
  // segmento entero) y el toggle aplica solo a esa parte. El estado vivo llega
  // por el evento tipado del controller + selectionchange (offsets del caret).
  const [selSty, setSelSty] = useState<{ bold: boolean; italic: boolean; underline?: boolean } | null>(null);
  const [liveState, setLiveState] = useState<StyleState | null>(() => controller.styleState);
  useEffect(() => {
    const update = () => {
      setLiveState(controller.styleState);
      setSelSty(controller.selectionStyle);
    };
    update();
    const sub = controller.onStyleStateChanged(() => update());
    document.addEventListener('selectionchange', update);
    return () => {
      sub.dispose();
      document.removeEventListener('selectionchange', update);
    };
  }, [controller, seg, edit]);
  const allBold = selSty ? selSty.bold : styled.length > 0 && styled.every(r => r.bold);
  const allItalic = selSty ? selSty.italic : styled.length > 0 && styled.every(r => r.italic);
  const allUnderline = selSty ? !!selSty.underline : styled.length > 0 && styled.every(r => !!r.underline);
  const toggle = (key: 'bold' | 'italic' | 'underline') => {
    if (controller.isOpen()) {
      // applyStyle es SÍNCRONO: el controller ya mutó los runs — refrescar el
      // estado del botón al toque.
      controller.applyStyle({ key });
      setSelSty(controller.selectionStyle);
      return;
    }
    const next = key === 'bold' ? !allBold : key === 'italic' ? !allItalic : !allUnderline;
    // Modelo Lbl/LBody: el MARCADOR de lista no recibe el formato del cuerpo —
    // subrayar el segmento no subraya el "•"/"A." ni su gap (antes la línea
    // cruzaba el hueco de la viñeta).
    const skip = listMarkerLen(styledText(styled));
    const font = `${seg.fontSize}px ${family(dominantRun(seg))}`;
    // El bake dibuja el subrayado con el ancho medido del tramo (`w`) — sin w
    // no dibuja nada. Medirlo acá para cada tramo que GANA subrayado.
    const withW = (r: StyledRun): StyledRun =>
      key === 'underline' && next ? { ...r, underline: true, w: round1(measureWidth(r.text, font)) } : { ...r, [key]: next };
    onPatch({
      runs: styled.flatMap((r, i) => {
        if (skip === 0) return [withW(r)];
        // cortar el Lbl del primer tramo: queda SIN el estilo nuevo, y el cuerpo
        // corre su dx el ancho del marcador (posición absoluta intacta).
        let consumed = 0;
        for (let j = 0; j < i; j++) consumed += styled[j]!.text.length;
        const localSkip = Math.max(0, Math.min(r.text.length, skip - consumed));
        if (localSkip === 0) return [withW(r)];
        const lblText = r.text.slice(0, localSkip);
        const lbl = { ...r, text: lblText };
        const body = r.text.slice(localSkip);
        return body
          ? [lbl, withW({ ...r, text: body, dx: round1((r.dx ?? 0) + measureWidth(lblText, font)) })]
          : [lbl];
      }),
    });
  };
  const eff = effectiveGeometry(seg, edit);
  // Alinear el TEXTO dentro del área (no mover el nodo): con el editor abierto
  // va directo al controller (display en vivo); si no, se recalcula el dx de
  // cada línea acá con applyAlign (frame = ancho del área).
  const curAlign: 'left' | 'center' | 'right' = edit?.align ?? 'left';
  const setAlign = (a: 'left' | 'center' | 'right') => {
    if (controller.isOpen()) {
      controller.applyStyle({ key: 'align', align: a });
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
    if (controller.isOpen()) {
      controller.applyStyle({ key: 'color', color: v });
      return;
    }
    onPatch({ color: v.toLowerCase() === (dom.color ?? '#000000').toLowerCase() ? null : v });
  };

  // Lista = un FORMATO más del texto: toggle del marcador "•  " al frente
  // (Enter en edición continúa la lista con el marcador incrementado).
  // Con el editor ABIERTO, el toggle va al controller (muta el textarea en
  // vivo — mismo principio que B/I/color). Cerrado: por el modelo.
  const [listMenu, setListMenu] = useState(false);
  // Activo con CUALQUIER marcador ("•", "A.", "1)", "i)") — todos son listas.
  // Editando: el marcador vive FUERA del textarea (Lbl colgante) → markerKind;
  // en modo plano los runs vivos traen el marcador inline.
  const isList = liveState
    ? (liveState.markerKind != null || hasListMarker(styledText(liveState.runs)))
    : hasListMarker(styledText(styled));
  const toggleList = (kind: ListKind = 'bullet') => {
    if (controller.isOpen()) {
      controller.applyStyle({ key: 'list', listKind: kind });
      setLiveState(controller.styleState); // refresca el estado del botón
      return;
    }
    const next = toggleListMarker(styled, kind);
    if (next !== styled) {
      // MARCADOR COLGANTE (Word/Acrobat): el CONTENIDO no se mueve — el ancla x
      // se corre el DELTA de ancho del marcador (agregar/quitar/convertir) y el
      // dx del cuerpo compensa → su posición ABSOLUTA queda intacta.
      const font = `${seg.fontSize}px ${family(dominantRun(seg))}`;
      const before = styledText(styled), after = styledText(next);
      const wBefore = measureWidth(before.slice(0, listMarkerLen(before)), font);
      const wAfter = measureWidth(after.slice(0, listMarkerLen(after)), font);
      const delta = wAfter - wBefore; // cuánto CRECE el marcador
      const nx = round1(Math.max(4, eff.x - delta));
      const runs = next.map((r, i) =>
        listMarkerLen(after) > 0 && i === 0 ? { ...r, dx: 0 } : { ...r, dx: round1((r.dx ?? 0) + delta) });
      onPatch({ runs, text: after, x: nx === round1(seg.x) ? null : nx });
    }
  };

  return (
    <FloatingWrap>
      <FbBtn label="Negrita" onClick={() => toggle('bold')} active={allBold}><Bold size={14} /></FbBtn>
      <FbBtn label="Itálica" onClick={() => toggle('italic')} active={allItalic}><Italic size={14} /></FbBtn>
      <FbBtn label="Subrayado" onClick={() => toggle('underline')} active={allUnderline}><Underline size={14} /></FbBtn>
      <span className="fb-list">
        <FbBtn label="Lista con viñeta (Enter en edición agrega el siguiente ítem)" onClick={() => toggleList('bullet')} active={isList}><List size={14} /></FbBtn>
        <button className="fb-caret" title="Tipo de lista" onMouseDown={e => e.preventDefault()}
          onClick={e => { e.stopPropagation(); setListMenu(v => !v); }}>▾</button>
        {listMenu && (
          <div className="fb-menu" onMouseDown={e => e.preventDefault()}>
            {([['bullet', '•  viñeta'], ['number', '1.  número'], ['upper', 'A.  mayúscula'], ['lower', 'a)  minúscula'], ['roman', 'i)  romano']] as [ListKind, string][]).map(([k, lbl]) => (
              <button key={k} className="fb-menu-item" onClick={e => { e.stopPropagation(); setListMenu(false); toggleList(k); }}>{lbl}</button>
            ))}
          </div>
        )}
      </span>
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
