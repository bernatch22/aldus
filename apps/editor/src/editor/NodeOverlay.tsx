/**
 * NodeOverlay se descompuso en ./overlay/* (raíz de composición + boxes + hooks).
 * Este archivo queda como re-export fino para no tocar los importadores
 * (PdfCanvas, Inspector, usePlacement).
 */
export * from './overlay/NodeOverlay';
