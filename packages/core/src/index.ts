/**
 * @aldus/core — public surface (F0: Layer 0 + container + errors).
 * El dominio (model/graph/edit/layout/pdf) llega en F2-F4.
 */

// common — Layer 0
export * from './common/bytes.js';
export * from './common/cancellation.js';
export * from './common/coords.js';
export * from './common/disposable.js';
export * from './common/events.js';
export * from './common/log.js';
export * from './common/mapUsingProjection.js';
export * from './common/matrix.js';
export * from './common/once.js';
export * from './common/rawFill.js';
export * from './common/text.js';

// ioc + errors
export * from './ioc/container.js';
export * from './errors.js';
