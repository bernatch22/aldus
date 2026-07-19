/**
 * ioc.ts — LA composition root del agente (art-of-code C3): el manifiesto de
 * qué implementación juega cada contrato. Se lee entero.
 *
 * Un HOST (CLI, server, Signwax) crea el container y puede:
 *   - bindear SUS PROPIAS {@link IAgentTool} (dominio: firmantes, envíos…) —
 *     multi-binding, el registry las levanta solo (C4/OCP);
 *   - overridear {@link IAgentConfig} (modelo por request, tests);
 *   - overridear un transporte (tests: un fake de guion).
 *
 * Las tools nativas de Aldus entran acá, UNA LÍNEA POR TOOL, fase a fase
 * (AGENT-PLAN.md) — la lista de binds ES el changelog de capacidades.
 */
import { Container } from '@aldus/core';
import { registerNodeFontProviders } from '@aldus/core/node';
import { IAgentConfig, loadAgentConfig } from './config.js';
import { IAgentTool } from './tools/contract.js';
import { addFormFieldTool } from './tools/edit/addFormField.js';
import { addLinkTool } from './tools/edit/addLink.js';
import { addTextTool } from './tools/edit/addText.js';
import { deleteElementTool } from './tools/edit/deleteElement.js';
import { deleteTextTool } from './tools/edit/deleteText.js';
import { editTextTool } from './tools/edit/editText.js';
import { fillFieldTool, fillFieldsTool } from './tools/edit/fillField.js';
import { headerFooterTool } from './tools/edit/headerFooter.js';
import { highlightTextTool } from './tools/edit/highlightText.js';
import { insertImageTool } from './tools/edit/insertImage.js';
import { moveFieldTool } from './tools/edit/moveField.js';
import { moveImageTool } from './tools/edit/moveImage.js';
import { moveTextTool } from './tools/edit/moveText.js';
import { watermarkTool } from './tools/edit/watermark.js';
import { placeholdersToFieldsTool } from './tools/edit/placeholdersToFields.js';
import { placeholdersToFieldsBatchTool } from './tools/edit/placeholdersToFieldsBatch.js';
import { replaceParagraphTool } from './tools/edit/replaceParagraph.js';
import { replacePageTool } from './tools/edit/replacePage.js';
import { replaceSectionTool } from './tools/edit/replaceSection.js';
import { setTextColorTool } from './tools/edit/setTextColor.js';
import { setTextSizeTool } from './tools/edit/setTextSize.js';
import { setTextStyleTool } from './tools/edit/setTextStyle.js';
import { IToolRegistry, ToolRegistry } from './tools/registry.js';

export interface AgentContainerOpts {
  /** Config propia (tests, modelo por request). Default: entorno. */
  config?: IAgentConfig;
}

export function createAgentContainer(opts: AgentContainerOpts = {}): Container {
  // Fuentes sustitutas REALES (original del sistema → gemela métrica) para el
  // bake — igual que el server (composition.ts). Sin esto, el texto reescrito
  // cuyo subset embebido no alcanza caía a la ESTÁNDAR (Times/Helvetica) y el
  // párrafo quedaba en otra tipografía. Idempotente: registrar dos veces no duele.
  registerNodeFontProviders();

  const container = new Container();

  container.bind(IAgentConfig).toConstantValue(opts.config ?? loadAgentConfig());

  // ── Tools nativas (una línea por tool; el orden es el del catálogo) ──────
  // El reader NO tiene tools de lectura: el contenido va inline en su prompt.
  // EDICIÓN (nivel editor)
  container.bind(IAgentTool).toConstantValue(editTextTool);                  // F3
  container.bind(IAgentTool).toConstantValue(placeholdersToFieldsTool);      // F3b
  container.bind(IAgentTool).toConstantValue(placeholdersToFieldsBatchTool); // F3c (una llamada por página)
  container.bind(IAgentTool).toConstantValue(fillFieldTool);                 // F3d (completar campos)
  container.bind(IAgentTool).toConstantValue(fillFieldsTool);                // F3d
  container.bind(IAgentTool).toConstantValue(deleteTextTool);                // F4
  container.bind(IAgentTool).toConstantValue(replaceParagraphTool);          // F4
  container.bind(IAgentTool).toConstantValue(replaceSectionTool);            // cross-página
  container.bind(IAgentTool).toConstantValue(replacePageTool);               // página entera con estilos
  container.bind(IAgentTool).toConstantValue(setTextStyleTool);              // F4
  container.bind(IAgentTool).toConstantValue(setTextColorTool);              // F4
  container.bind(IAgentTool).toConstantValue(setTextSizeTool);               // F4
  // GEOMETRÍA (mover / borrar) — F5
  container.bind(IAgentTool).toConstantValue(moveTextTool);                  // F5
  container.bind(IAgentTool).toConstantValue(moveFieldTool);                 // F5
  container.bind(IAgentTool).toConstantValue(moveImageTool);                 // F5
  container.bind(IAgentTool).toConstantValue(deleteElementTool);             // F5
  // CREACIÓN (texto/campo/imagen/resaltado/link/marca/encabezado) — F6
  container.bind(IAgentTool).toConstantValue(addTextTool);                   // F6
  container.bind(IAgentTool).toConstantValue(addFormFieldTool);              // F6
  container.bind(IAgentTool).toConstantValue(highlightTextTool);            // F6
  container.bind(IAgentTool).toConstantValue(addLinkTool);                   // F6
  container.bind(IAgentTool).toConstantValue(watermarkTool);                 // F6
  container.bind(IAgentTool).toConstantValue(headerFooterTool);              // F6
  container.bind(IAgentTool).toConstantValue(insertImageTool);               // F6

  container.bind(IToolRegistry).to(ToolRegistry);

  return container;
}
