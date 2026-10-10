import {randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import {createInterface} from 'node:readline';

const scenarios = new Set(['fallback', 'stall', 'retry', 'replacement-a', 'replacement-b', 'burst', 'failure', 'delivery-order']);

// This listener exists only in the explicitly launched test process, never in Lumen.
export async function createAnswerNativeBridge({stdin, stdout}) {
  const token = randomBytes(24).toString('hex');
  const active = new Map();
  const samples = [];
  const send = (value) => stdin.write(`${JSON.stringify(value)}\n`);
  const lines = createInterface({input: stdout, crlfDelay: Infinity});
  lines.on('line', (line) => {
    if (!line.startsWith('{')) return; // libtest writes its own headings around stdout.
    if (line.length > 256 * 1024) throw new Error('Native test bridge line exceeded its bound.');
    const message = JSON.parse(line);
    const sample = samples.findLast((item) => item.requestId === message.requestId);
    if (sample && message.event) {
      sample.events++;
      if (message.event.type === 'delta' && sample.firstTokenMs === undefined) sample.firstTokenMs = performance.now() - sample.startedAt;
      if (message.event.type === 'started') sample.attempts++;
    }
    if (sample && message.done) {
      sample.doneMs = performance.now() - sample.startedAt;
      if (sample.cancelledAt !== undefined) sample.cancelToNativeDoneMs = performance.now() - sample.cancelledAt;
    }
    const response = active.get(message.requestId);
    if (!response) return;
    response.write(`${line}\n`);
    if (response.writableLength > 512 * 1024) {
      send({command: 'cancel', requestId: message.requestId});
      response.destroy(new Error('Native test bridge client exceeded its buffer.'));
      active.delete(message.requestId);
      return;
    }
    if (message.done) { active.delete(message.requestId); response.end(); }
  });
  const server = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:1420');
    response.setHeader('Access-Control-Allow-Headers', 'content-type,x-lumen-test-token');
    response.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
    if (request.headers['x-lumen-test-token'] !== token) { response.writeHead(403).end(); return; }
    let body = '';
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 8192) { response.writeHead(413).end(); return; }
    }
    let payload;
    try { payload = JSON.parse(body); } catch { response.writeHead(400).end(); return; }
    if (request.method !== 'POST' || !payload || typeof payload !== 'object'
      || !Number.isSafeInteger(payload.requestId)) { response.writeHead(400).end(); return; }
    if (request.url === '/cancel') {
      const sample = samples.findLast((item) => item.requestId === payload.requestId);
      if (sample) sample.cancelledAt = performance.now();
      send({command: 'cancel', requestId: payload.requestId});
      response.writeHead(204).end();
      return;
    }
    if (request.url !== '/start' || !scenarios.has(payload.query)
      || !['auto', 'local', 'cloud'].includes(payload.mode) || typeof payload.cloudConsent !== 'boolean'
      || active.has(payload.requestId) || active.size >= 4) { response.writeHead(400).end(); return; }
    if (samples.length >= 100) samples.shift();
    samples.push({requestId: payload.requestId, query: payload.query, startedAt: performance.now(), events: 0, attempts: 0});
    active.set(payload.requestId, response);
    response.writeHead(200, {'content-type': 'application/x-ndjson', 'cache-control': 'no-store'});
    response.flushHeaders();
    const abandoned = () => {
      if (active.delete(payload.requestId)) send({command: 'cancel', requestId: payload.requestId});
    };
    response.on('close', abandoned);
    request.socket.once('close', abandoned);
    response.once('finish', () => request.socket.off('close', abandoned));
    send({command: 'start', request: payload});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`, token, samples,
    get activeRequests() { return active.size; },
    async close() {
      for (const [requestId, response] of active) { send({command: 'cancel', requestId}); response.destroy(); }
      active.clear();
      lines.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
