import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

// Exercise asynchronous callbacks after timing so error and timer paths are recorded separately.
export async function exerciseLifecycleCallbacks(modules, tab, endpoint, file, captured, times, synthetic) {
  const t = modules.timeout;
  const pending = new Promise(() => {});
  await t.settleWithin(Promise.reject(new Error('fixture')), 10);
  await assert.rejects(t.rejectAfterTimeout(pending, 1, 'expired'), /expired/);
  const abort = new AbortController();
  const wait = t.rejectOnAbort(() => pending, abort.signal);
  abort.abort(new Error('cancelled'));
  await assert.rejects(wait, /cancelled/);
  const server = createServer(() => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await assert.rejects(modules.cdpConnection.connectOverCDP('http://127.0.0.1:' + server.address().port, { timeout: 20 }));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  const cdp = modules.cdpConnection;
  if (process.platform === 'linux')
    assert.match(await cdp.websocketEndpoint('chrome', {}, new AbortController().signal), /^ws:\/\/localhost:/);
  // Each rare callback gets a live disposable connection. Inject the event directly
  // on its real closure, keeping these samples distinct from observed transport events.
  const missed = [...captured.keys()].filter(key => key.startsWith(file + '#') && !times.has(key));
  for (const key of missed) {
    synthetic.add(key);
    for (let i = 0; i < 6; i++) {
      const browser = await cdp.connectOverCDP(endpoint, { headers: { 'User-Agent': 'utils-bench' } });
      try {
        const { event, callback } = captured.get(key);
        if (event === 'http.request') {
          let status;
          callback({}, { writeHead(code) { status = code; return { end() {} }; } });
          assert.equal(status, 404);
        } else {
          callback(new Error('synthetic connection lifecycle event'));
        }
      } finally {
        await browser.close();
      }
    }
  }
  const activity = new modules['tools/utils'].PageActivity(tab);
  // Exercise the genuine ten-second inactivity timeout during the untimed replay.
  await activity.waitUntilIdle(10100);
  activity.dispose();
}
