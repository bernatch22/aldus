# Security Policy

## Posture

Aldus is a **local-first** tool. The server binds `127.0.0.1` by design:
documents are stored unencrypted on disk (`apps/server/data/`) and the API has
no authentication. Setting `ALDUS_ALLOW_REMOTE=1` binds `0.0.0.0` — only do
that behind your own reverse proxy + auth.

The `/api/documents/:id/agent` endpoint spends LLM turns (Claude Code
subscription or API credits): treat it as a paid resource and never expose it
publicly unauthenticated.

Uploaded PDFs are parsed with `pdf-lib` and `pdf.js`; malformed files are
rejected or fail safe (the bake refuses streams it can't parse), but you
should still not feed untrusted PDFs to a server holding sensitive documents.

## Reporting a vulnerability

Email **bernacas@gmail.com** with a proof of concept. Please don't open a
public issue for security reports. You'll get a response within a week.
