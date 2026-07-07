# Contributing to Aldus

Thanks for wanting to hack on a real content-stream editor. This codebase has
a few laws — they exist because breaking them has already bitten us.

## Setup

```bash
pnpm install
pnpm dev            # server :4100 + editor :5190 (proxied /api)
pnpm -r test        # the gate for every PR
```

Node ≥ 20, pnpm ≥ 9. No Docker, no external services. The AI panel needs a
Claude Code subscription (run the server WITHOUT `ANTHROPIC_API_KEY`).

## The laws

1. **Coordinates are PDF points, origin bottom-left, ALWAYS.** The only place
   that converts PDF↔CSS is `packages/core/src/coords.ts`. If you write
   `height - y` anywhere else, your PR will be asked to move it there.
2. **Gap thresholds live only in `packages/core/src/tokens.ts`** — extraction
   and bake share them. One source of truth.
3. **The bake never guesses.** If an edit can't be located unambiguously by
   geometry, skip it with a warning. A wrong byte in a content stream corrupts
   someone's contract.
4. **No paint-over, ever.** Splices replace operators in place (z-order
   intact); new content is re-encoded with the original font when possible,
   and substitution is explicit and reported.
5. **Don't duplicate logic.** If the rule exists in core (e.g.
   `promoteMovedImages`), import it. Two copies drift.

## Adding a text-emit path (the OCP walkthrough)

The bake's text paths are strategies (`packages/core/src/bake/text.ts`):

```ts
export interface ITextEmitStrategy {
  canHandle(edit: SegmentEdit): boolean;  // cheap, stateless self-gate
  emit(ctx: SegmentEmitContext): void;
}
```

Write a class, add it to `textEmitStrategies` BEFORE the catch-all
`StyledRunsReemit`. Never edit a sibling strategy to add a capability.

## Testing

- Core: **real-cycle tests** (`packages/core/test/`) — build a PDF with
  pdf-lib, extract, bake, re-extract, assert. Add one for any bake change.
- Editor: `styledDom` is tested in jsdom (`*.test.ts` next to the source).
  Pure helpers get colocated unit tests.
- Never verify a bake change by eyeballing a viewer only — the re-extraction
  IS the assertion.

## Style

- TypeScript strict, one primary component/class per file, files named after
  what they export.
- Comments document *invariants and why*, not what the next line does. The
  Spanish comments carry battle history — keep them; new public API JSDoc in
  English.
- Debug output goes through `createLogger('aldus:…')` from `@aldus/core` —
  never a raw `console.log` in production paths.

## PRs

Keep them scoped; `pnpm -r test` green; if you changed behavior, update the
README/docs in the same PR (stale docs are treated as bugs).
