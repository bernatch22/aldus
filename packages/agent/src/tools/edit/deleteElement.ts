/**
 * delete_element — elimina CUALQUIER elemento por id (imagen, campo, resaltado,
 * link o texto), detectando su tipo. Una sola puerta en vez de una tool por
 * tipo. Para texto con "subir lo de abajo" usá delete_text (pull_up).
 */
import { z } from 'zod';
import type { IAgentTool } from '../contract.js';

export const deleteElementTool: IAgentTool = {
  name: 'delete_element',
  description:
    'Elimina un elemento por id: imagen, campo de formulario, resaltado o link ' +
    '(también texto, pero para texto preferí delete_text si querés cerrar el hueco). ' +
    'Detecta el tipo solo.',
  level: 'editor',
  shape: {
    id: z.string().regex(/^p\d+-\S+$/).describe('id del elemento a eliminar'),
  },

  run: ({ session }, args) => session.deleteElement(args.id as string),
};
