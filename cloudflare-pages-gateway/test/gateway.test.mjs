import assert from 'node:assert/strict';
import test from 'node:test';

import gateway from '../public/_worker.js';

test('encaminha pedidos, sessão e cookies para o Portal protegido', async () => {
  const request = new Request('https://portal-anepc-alto-minho.pages.dev/api/session', {
    headers: { Cookie: 'dashboard_session=teste' }
  });
  let forwardedRequest;
  const response = await gateway.fetch(request, {
    PORTAL_WORKER: {
      async fetch(value) {
        forwardedRequest = value;
        return new Response('{"ok":true}', {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': 'dashboard_session=renovada; Secure; HttpOnly; SameSite=Strict'
          }
        });
      }
    }
  });

  assert.equal(forwardedRequest, request);
  assert.equal(forwardedRequest.headers.get('cookie'), 'dashboard_session=teste');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.match(response.headers.get('set-cookie') || '', /^dashboard_session=renovada;/);
  assert.deepEqual(await response.json(), { ok: true });
});

test('falha de forma controlada se a ligação interna não existir', async () => {
  const response = await gateway.fetch(
    new Request('https://portal-anepc-alto-minho.pages.dev/health'),
    {}
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: 'Ligação interna ao Portal indisponível.'
  });
});
