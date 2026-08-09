import assert from 'node:assert/strict';

const deploymentUrl = String(process.env.DEPLOYMENT_URL || '').replace(/\/$/, '');
assert.match(deploymentUrl, /^https:\/\/[a-z0-9-]+\.pages\.dev$/i);

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function requestUntil(path, accepts, description) {
  let lastStatus = 0;
  let lastBody = '';
  let lastLocation = '';

  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      const response = await fetch(`${deploymentUrl}${path}`, { redirect: 'manual' });
      const body = await response.text();
      if (accepts(response, body)) return { response, body };
      lastStatus = response.status;
      lastBody = body.slice(0, 200);
      lastLocation = response.headers.get('location') || '';
    } catch (error) {
      lastStatus = 0;
      lastBody = String(error);
      lastLocation = '';
    }

    if (attempt < 12) await wait(5_000);
  }

  throw new Error(
    `${description}: última resposta ${lastStatus}, Location=${lastLocation}, Body=${lastBody}`
  );
}

const health = await requestUntil(
  '/health',
  (response, body) => {
    if (response.status !== 200) return false;
    try {
      return JSON.stringify(JSON.parse(body)) === JSON.stringify({
        ok: true,
        service: 'dashboard-anepc'
      });
    } catch {
      return false;
    }
  },
  'O gateway não alcançou o Portal protegido'
);
assert.deepEqual(JSON.parse(health.body), { ok: true, service: 'dashboard-anepc' });

const root = await requestUntil(
  '/',
  (response) => response.status === 302 && response.headers.get('location') === '/login.html?next=%2F',
  'A raiz protegida não ficou disponível no domínio Pages'
);
assert.equal(root.response.headers.get('location'), '/login.html?next=%2F');

const login = await requestUntil(
  '/login.html',
  (response, body) => response.status === 200 && /id="form-login"/.test(body),
  'A página de login não ficou disponível no domínio Pages'
);
assert.match(login.body, /id="form-login"/);

const session = await requestUntil(
  '/api/session',
  (response, body) => {
    if (response.status !== 401) return false;
    try {
      return JSON.parse(body).error === 'Sessão inválida ou expirada.';
    } catch {
      return false;
    }
  },
  'A ligação do gateway ao armazenamento de sessões falhou'
);
assert.deepEqual(JSON.parse(session.body), {
  ok: false,
  error: 'Sessão inválida ou expirada.'
});

console.log(`Gateway do Portal validado: ${deploymentUrl}`);
