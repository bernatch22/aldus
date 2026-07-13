/**
 * node/composition.node.ts — composition root Node: los bindings con I/O que
 * el browser jamás debe ver. Multi-bindea los font providers al token
 * {@link IFallbackFontProvider} (orden = orden de probing: sistema primero,
 * gemela métrica después) y los vuelca al registry global para que la API npm
 * sin container (bake/bakeSegmentEdits) también los use.
 */
import { Container } from '../ioc/container.js';
import { adoptContainerFontProviders, IFallbackFontProvider } from '../bake/fonts/fontProviders.js';
import { MetricTwinProvider, SystemFontProvider } from './fontsNode.js';

/** Container Node: hereda (o crea) el core container y agrega los providers. */
export function createNodeContainer(parent?: Container): Container {
  const container = parent ? parent.createChild() : new Container();
  // Orden de bind = orden de probing (regla del registry: el primero que
  // resuelve gana): la fuente REAL del sistema antes que la gemela descargada.
  container.bind(IFallbackFontProvider).to(SystemFontProvider);
  container.bind(IFallbackFontProvider).to(MetricTwinProvider);
  adoptContainerFontProviders(container);
  return container;
}
