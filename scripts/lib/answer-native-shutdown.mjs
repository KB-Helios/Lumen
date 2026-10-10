import {clearTimeout} from 'node:timers';

export async function finishNativeAnswerProcess(child, timeoutMs = 5000) {
  const began = performance.now();
  let onExit;
  let onError;
  let timer;
  let killTimer;
  const exited = new Promise((resolve, reject) => {
    onExit = (code, signal) => resolve({code, signal});
    onError = reject;
    child.once('exit', onExit);
    child.once('error', onError);
    if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode, child.signalCode);
  });
  try {
    if (child.exitCode === null && child.signalCode === null) child.stdin.end();
    const result = await Promise.race([exited, new Promise((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs);
    })]);
    if (!result) {
      child.kill();
      await Promise.race([exited, new Promise((resolve) => { killTimer = setTimeout(resolve, 1000); })]);
      throw new Error(`Native answer shutdown timed out after ${timeoutMs} ms.`);
    }
    if (result.code !== 0 || result.signal) {
      throw new Error(`Native answer test process exited with code ${result.code} and signal ${result.signal}.`);
    }
    return {...result, elapsedMs: performance.now() - began};
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    child.off('exit', onExit);
    child.off('error', onError);
  }
}
