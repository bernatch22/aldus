/**
 * lib.ts — la ENTRY de `aldus-editor` como LIBRERÍA React embebible.
 * SUPERFICIE EXACTA de v1 (`apps/editor/src/lib.ts`).
 *
 * Un host real (signwax) importa de acá y monta el editor completo dentro de
 * SU app:
 *
 *   import { AldusEditor, configureAldusApi } from 'aldus-editor';
 *   import 'aldus-editor/styles.css';
 *   configureAldusApi({ apiBase: '/api/aldus' });   // su host del wire protocol
 *   <AldusEditor docId={id} onExit={volver} agent={false} formTools={false} />
 *
 * El host debe además fijar el worker de pdf.js (peer dep):
 *   GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url)…
 *
 * OJO: acá NO se exporta la ruta de la app demo (react-router) — el
 * tree-shaking deja a react-router-dom fuera del bundle del host.
 */
import '../styles-lib.css';

export { AldusEditor, configureAldusApi, aldusApi } from './AldusEditor.js';
export type { AldusEditorProps } from './AldusEditor.js';
export type { HostBox } from './boxes/HostBoxLayer.js';
// El cliente del wire protocol, para que el host reuse el MISMO transporte del
// editor (p. ej. `aldusApi.agentStream` para SU chat de agente).
export type { AgentEvent, AgentRole, DocMeta } from '../core/index.js';
