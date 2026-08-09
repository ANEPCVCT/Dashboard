import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../src/index.js';

const origin = 'https://anepcvct.github.io';
const baseEnv = {
  ALLOWED_ORIGIN: origin,
  EPE_OPERATOR_KEY: 'segredo-de-teste',
  GITHUB_TOKEN: 'token-de-teste'
};
const validPayload = {
  versao: 1,
  timezone: 'Europe/Lisbon',
  agendamentos: [{
    nivel: 'I',
    tipo: 'ELEVACAO',
    inicio: '2026-08-10T08:00',
    fim: '2026-08-10T18:00'
  }]
};

test('Worker EPE', async (suite) => {
  await suite.test('recusa origens não autorizadas', async () => {
    const response = await worker.fetch(
      new Request('https://worker.test/health', {
        headers: { Origin: 'https://example.com' }
      }),
      baseEnv
    );
    assert.equal(response.status, 403);
  });

  await suite.test('expõe apenas o health check à origem autorizada', async () => {
    const response = await worker.fetch(
      new Request('https://worker.test/health', {
        headers: { Origin: origin }
      }),
      baseEnv
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      service: 'dashboard-anepc-epe'
    });
  });

  await suite.test('exige chave de operador', async () => {
    const response = await worker.fetch(
      new Request('https://worker.test/epe', {
        method: 'POST',
        headers: {
          Origin: origin,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(validPayload)
      }),
      baseEnv
    );
    assert.equal(response.status, 401);
  });

  await suite.test('recusa mais de quatro determinações', async () => {
    const response = await worker.fetch(
      new Request('https://worker.test/epe', {
        method: 'POST',
        headers: {
          Origin: origin,
          Authorization: 'Bearer segredo-de-teste',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          ...validPayload,
          agendamentos: Array.from({ length: 5 }, () => validPayload.agendamentos[0])
        })
      }),
      baseEnv
    );
    assert.equal(response.status, 400);
  });

  await suite.test('aciona apenas o workflow previsto', async () => {
    const originalFetch = globalThis.fetch;
    let captured;

    globalThis.fetch = async (url, options) => {
      captured = { url, options };
      return new Response(null, { status: 204 });
    };

    try {
      const response = await worker.fetch(
        new Request('https://worker.test/epe', {
          method: 'POST',
          headers: {
            Origin: origin,
            Authorization: 'Bearer segredo-de-teste',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(validPayload)
        }),
        baseEnv
      );
      const responseBody = await response.json();

      assert.equal(response.status, 202);
      assert.equal(responseBody.ok, true);
      assert.match(responseBody.request_id, /^[0-9a-f-]{36}$/);
      assert.equal(
        captured.url,
        'https://api.github.com/repos/ANEPCVCT/Dashboard/actions/workflows/atualizar-epe.yml/dispatches'
      );
      assert.equal(captured.options.method, 'POST');
      assert.equal(captured.options.headers.Authorization, 'Bearer token-de-teste');

      const githubBody = JSON.parse(captured.options.body);
      assert.equal(githubBody.ref, 'main');
      const dispatched = JSON.parse(githubBody.inputs.epe_payload);
      assert.equal(dispatched.versao, 1);
      assert.equal(dispatched.agendamentos.length, 1);
      assert.match(dispatched.request_id, /^[0-9a-f-]{36}$/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
