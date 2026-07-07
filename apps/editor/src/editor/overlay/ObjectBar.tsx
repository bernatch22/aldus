/**
 * ObjectBar — toolbar flotante para IMAGEN o CAMPO: alineación (relativa a la
 * página) + (imagen) orden Z + eliminar.
 */
import { AlignLeft, AlignCenter, AlignRight, Trash2, SendToBack, BringToFront } from 'lucide-react';
import { FbBtn, FbSep, FloatingWrap } from './toolbar';

/** Toolbar flotante para IMAGEN o CAMPO: alineación + (imagen) orden Z + eliminar. */
export function ObjectBar({ rect, pageWidth, width, onAlign, onZ, onDelete }: {
  rect: { left: number; top: number };
  pageWidth: number;
  width: number;
  onAlign?: (x: number) => void;
  onZ?: (o: 'front' | 'back') => void;
  onDelete: () => void;
}) {
  const MARGIN = 40;
  return (
    <FloatingWrap rect={rect}>
      {onAlign && <>
        <FbBtn label="Alinear a la izquierda de la página" onClick={() => onAlign(MARGIN)}><AlignLeft size={14} /></FbBtn>
        <FbBtn label="Centrar en la página" onClick={() => onAlign((pageWidth - width) / 2)}><AlignCenter size={14} /></FbBtn>
        <FbBtn label="Alinear a la derecha de la página" onClick={() => onAlign(pageWidth - MARGIN - width)}><AlignRight size={14} /></FbBtn>
        {onZ && <FbSep />}
      </>}
      {onZ && <>
        <FbBtn label="Enviar al fondo" onClick={() => onZ('back')}><SendToBack size={14} /></FbBtn>
        <FbBtn label="Traer al frente" onClick={() => onZ('front')}><BringToFront size={14} /></FbBtn>
      </>}
      {(onAlign || onZ) && <FbSep />}
      <FbBtn label="Eliminar" onClick={onDelete} danger><Trash2 size={14} /></FbBtn>
    </FloatingWrap>
  );
}
