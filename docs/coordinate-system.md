# The coordinate contract

**Everything in Aldus speaks PDF points, origin at the BOTTOM-LEFT, y grows
UP. Always.** The model, the edits, the bake, the server API, the agent's
tools — all of it.

For text nodes, `y`/`baseline` is the **baseline** (the typographic line), not
the top of a box. `fontSize = hypot(c, d)` of the text matrix, so rotated or
scaled text reports its effective size.

## The single conversion point

The ONLY module that converts to/from CSS space (origin top-left, y grows
down) is [`packages/core/src/coords.ts`](../packages/core/src/coords.ts):

```ts
pdfRectToCss(rect, pageHeight, scale)   // model → overlay boxes
cssPointToPdf(point, pageHeight, scale) // clicks → model
```

If you find yourself writing `pageHeight - y` anywhere else, stop and route it
through `coords.ts`. Scattered flips are how off-by-one-baseline bugs are
born, and they are miserable to debug on a zoomed HiDPI canvas.

## Why bottom-left everywhere (and not just at the edges)

Because the content stream itself speaks bottom-left: text matrices, image
CTMs, widget `/Rect`s. Keeping the model in PDF space means the bake can take
a `SegmentEdit.x` and emit it into the stream **without any transformation**
— the coordinate you see in an edit JSON is the coordinate that lands in the
`Tm`. One mental space, one conversion boundary, zero drift.
