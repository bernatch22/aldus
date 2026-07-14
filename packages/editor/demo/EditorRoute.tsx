/**
 * EditorRoute — la PÁGINA del editor de la app de EJEMPLO (demo/): un wrapper
 * fino con react-router sobre el componente embebible. Vive en su PROPIO
 * módulo para que la build de librería (lib.ts) no arrastre el router: un
 * host real (signwax) importa `AldusEditor` de `aldus-editor` y monta su
 * propia pantalla.
 */
import { Link, useParams } from 'react-router-dom';
import { AldusEditor } from '../src/react/AldusEditor.js';

export function EditorPage() {
  const { id = '' } = useParams();
  return (
    <AldusEditor
      docId={id}
      brand={
        <Link to="/" className="flex items-center gap-1.5 text-[15px] font-semibold tracking-tight text-neutral-900">
          <span className="grid h-6 w-6 place-items-center rounded-md bg-blue-600 text-white text-[13px] font-bold">A</span>
          Aldus
        </Link>
      }
    />
  );
}
