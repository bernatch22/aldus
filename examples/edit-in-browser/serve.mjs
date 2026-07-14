#!/usr/bin/env node
/**
 * The smallest possible Aldus app: open a local PDF and get the FULL editor +
 * the CASPER AI agent in your browser. No database, no accounts, no sessions.
 *
 * It reimplements NOTHING — `openInEditor` (from @aldus/agent, also shipped in
 * `aldus-pdf`) boots the real server in local mode serving the built editor
 * SPA, uploads the PDF, and opens the browser at that document. `aldus
 * contract.pdf` from the CLI is this exact call.
 */
import { openInEditor } from '@aldus/agent';

const file = process.argv[2];
if (!file) {
  console.error('uso: node serve.mjs <archivo.pdf>');
  process.exit(1);
}
await openInEditor(file);
