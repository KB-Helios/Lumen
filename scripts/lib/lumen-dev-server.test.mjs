import assert from 'node:assert/strict';
import http from 'node:http';
import {test} from 'node:test';
import {withLumenDevServer} from './lumen-dev-server.mjs';

async function serverFixture(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {url, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); })};
}

test('owned mode refuses a server that became ready after native preflight', async () => {
  let ready = false;
  const server = await serverFixture((_request, response) => { response.statusCode = ready ? 200 : 503; response.end('competing checkout'); });
  try {
    assert.equal((await fetch(server.url)).ok, false);
    ready = true;
    let calls = 0;
    await assert.rejects(withLumenDevServer(async () => { calls += 1; }, server.url, {reuseExistingServer: false}), /already ready; owned startup required/);
    assert.equal(calls, 0);
    assert.equal(await (await fetch(server.url)).text(), 'competing checkout');
  } finally { await server.close(); }
});

test('owned mode never accepts competing readiness while its Vite child fails to bind', async () => {
  let requests = 0;
  const server = await serverFixture((_request, response) => {
    response.statusCode = requests++ === 0 ? 503 : 200;
    response.end('competing checkout');
  });
  try {
    let calls = 0;
    await assert.rejects(withLumenDevServer(async () => { calls += 1; }, server.url, {reuseExistingServer: false}), /exited with code 1/);
    assert.equal(calls, 0);
    assert.equal(await (await fetch(server.url)).text(), 'competing checkout');
  } finally { await server.close(); }
});

test('existing callers retain intentional server reuse', async () => {
  const server = await serverFixture((_request, response) => response.end('existing checkout'));
  try {
    const result = await withLumenDevServer(async (url) => (await fetch(url)).text(), server.url);
    assert.equal(result, 'existing checkout');
  } finally { await server.close(); }
});

test('owned mode enters the callback after its own Vite startup and cleans it up', async () => {
  const reservation = await serverFixture((_request, response) => response.end());
  const url = reservation.url;
  await reservation.close();
  let calls = 0;
  await withLumenDevServer(async (ownedUrl) => {
    calls += 1;
    assert.equal(ownedUrl, url);
    assert.match(await (await fetch(ownedUrl)).text(), /Lumen/);
  }, url, {reuseExistingServer: false});
  assert.equal(calls, 1);
  await assert.rejects(fetch(url));
});
