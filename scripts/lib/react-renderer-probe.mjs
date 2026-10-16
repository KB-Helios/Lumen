// Observe the renderer's own DevTools registration, without walking fibers or
// doing any work on commits. Production profiling must also record nonempty
// Profiler samples in the ordinary-query phase.
export async function installReactRendererProbe(page) {
  await page.addInitScript(() => {
    const renderers = new Map();
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers,
      inject(renderer) { const id = renderers.size + 1; renderers.set(id, renderer); return id; },
      onCommitFiberRoot() {},
      onCommitFiberUnmount() {},
    };
  });
}

export async function readReactRenderers(page) {
  return page.evaluate(() => [...window.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers.values()]
    .map(({bundleType, version}) => ({bundleType, version})));
}
