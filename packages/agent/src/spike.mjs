/**
 * spike.mjs — prueba de vida del Agent SDK para Aldus.
 *
 * Verifica las tres piezas que el experimento viejo nunca llegó a probar juntas:
 *   1. Un tool CUSTOM (tool() + createSdkMcpServer) que el modelo invoca.
 *   2. Sonnet vía el Agent SDK.
 *   3. Autenticación por suscripción de Claude Code (correr SIN ANTHROPIC_API_KEY:
 *      `env -u ANTHROPIC_API_KEY node src/spike.mjs`).
 *
 * El tool devuelve un grafo de PDF de juguete (líneas con geometría, el mismo
 * formato <line x y w h> que usará @aldus/core) y le pedimos al modelo que lo lea.
 */

import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const FAKE_GRAPH = `<page n="1" width="612" height="792">
  <line x="72" y="708" w="220" h="14" font="Helvetica-Bold" size="14">CONTRATO DE SERVICIOS</line>
  <line x="72" y="680" w="380" h="10" font="Helvetica" size="10">Entre PARTE EMISORA y PARTE RECEPTORA se acuerda:</line>
  <line x="72" y="660" w="360" h="10" font="Helvetica" size="10">1. El plazo del contrato es de 12 meses.</line>
</page>`;

const getPdfGraph = tool(
  "get_pdf_graph",
  "Devuelve el grafo de contenido de una página del PDF: cada línea de texto con su geometría (puntos PDF, origen abajo-izquierda).",
  { page: z.number().int().min(1).describe("Número de página, 1-based") },
  async ({ page }) => ({
    content: [{ type: "text", text: page === 1 ? FAKE_GRAPH : `<page n="${page}" empty="true"/>` }],
  }),
);

const aldusServer = createSdkMcpServer({
  name: "aldus",
  version: "0.0.1",
  tools: [getPdfGraph],
});

let toolInvoked = false;
let finalText = null;

for await (const message of query({
  prompt:
    "Leé la página 1 del PDF con la tool get_pdf_graph y respondé: " +
    "(a) el título del documento, (b) en qué coordenada (x,y) está el título.",
  options: {
    model: "claude-sonnet-5",
    systemPrompt: "Sos Aldus, un agente que edita PDFs leyendo su grafo de contenido. Usá tus tools.",
    mcpServers: { aldus: aldusServer },
    allowedTools: ["mcp__aldus__get_pdf_graph"],
    maxTurns: 5,
  },
})) {
  if (message.type === "assistant") {
    for (const b of message.message.content) {
      if (b.type === "tool_use") {
        toolInvoked = true;
        console.log(`[tool_use] ${b.name} ${JSON.stringify(b.input)}`);
      }
    }
  } else if (message.type === "result") {
    finalText = message.subtype === "success" ? message.result : `(${message.subtype})`;
  }
}

console.log("\n[respuesta final]\n" + finalText);
console.log(toolInvoked ? "\n✅ TOOL CUSTOM INVOCADO — el patrón funciona" : "\n❌ el tool NO fue invocado");
process.exit(toolInvoked ? 0 : 1);
