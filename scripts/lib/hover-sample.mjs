// Standalone browser function, shared by the Edge test and evidence profiler.
export async function measureHoverSample(element) {
  const nextFrame = () => new Promise((resolve) => {
    requestAnimationFrame((nominalAt) => resolve({nominalAt, actualAt: performance.now()}));
  });
  const readBackground = () => globalThis.getComputedStyle(element).backgroundColor;
  const pointer = (type) => element.dispatchEvent(new PointerEvent(type, {
    bubbles: true, pointerType: 'mouse',
  }));

  // Resolve the intended token through the browser, independently of the row's
  // data-hovered selector. A missing utility must not become its own oracle.
  const swatch = element.ownerDocument.createElement('span');
  swatch.style.backgroundColor = globalThis.getComputedStyle(element)
    .getPropertyValue('--einui-command-row-hover');
  swatch.style.display = 'none';
  element.append(swatch);
  const expectedBackground = globalThis.getComputedStyle(swatch).backgroundColor;
  swatch.remove();

  const start = await nextFrame();
  const resetHovered = element.hasAttribute('data-hovered');
  const resetBackground = readBackground();
  const hoverStartedAt = performance.now();
  pointer('pointerover');
  const synchronousDispatchMs = performance.now() - hoverStartedAt;
  const end = await nextFrame();
  const hovered = element.hasAttribute('data-hovered');
  const background = readBackground();
  const ready = !resetHovered && resetBackground !== expectedBackground &&
    hovered && background === expectedBackground;
  return {
    responseMs: end.actualAt - hoverStartedAt,
    callbackIntervalMs: end.actualAt - start.actualAt,
    nominalFrameIntervalMs: end.nominalAt - start.nominalAt,
    callbackStartedAt: start.actualAt,
    hoverStartedAt,
    callbackEndedAt: end.actualAt,
    nominalStartedAt: start.nominalAt,
    nominalEndedAt: end.nominalAt,
    startCallbackOffsetMs: start.actualAt - start.nominalAt,
    endCallbackOffsetMs: end.actualAt - end.nominalAt,
    synchronousDispatchMs,
    resetHovered, resetBackground, hovered, background, expectedBackground, ready,
  };
}

export async function sampleHover(row) {
  // Reset outside the timed interaction and wait for the real React/CSS state.
  // Do not overwrite data-hovered, finish animations or repeatedly hover a hot row.
  await row.evaluate((element) => element.dispatchEvent(new PointerEvent('pointerout', {
    bubbles: true, pointerType: 'mouse', relatedTarget: element.ownerDocument.body,
  })));
  const handle = await row.elementHandle();
  try {
    await row.page().waitForFunction((element) => !element.hasAttribute('data-hovered') &&
      element.getAnimations().every((animation) => animation.playState !== 'running'), handle);
  } finally {
    await handle.dispose();
  }
  return row.evaluate(measureHoverSample);
}
