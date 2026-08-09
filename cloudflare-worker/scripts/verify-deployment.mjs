import assert from 'node:assert/strict';

const deploymentUrl = String(process.env.DEPLOYMENT_URL || '').replace(/\/$/, '');

assert.match(deploymentUrl, /^https:\/\//, 'URL HTTPS da implantação em falta.');
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function requestUntil(path, init, accepts, description) {
  let lastStatus = 0;
  let lastBody = '';
  let lastLocation = '';
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      const response = await fetch(`${deploymentUrl}${path}`, init);
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
    if (attempt < 10) await wait(4_000);
  }
  throw new Error(
    `${description}: última resposta ${lastStatus}, Location=${lastLocation}, Body=${lastBody}`
  );
}

const healthResult = await requestUntil(
  '/health',
  { redirect: 'manual' },
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
  'O endpoint de saúde não ficou disponível'
);
assert.deepEqual(JSON.parse(healthResult.body), { ok: true, service: 'dashboard-anepc' });

const { response: root } = await requestUntil(
  '/',
  { redirect: 'manual' },
  (response) => response.status === 302 && response.headers.get('location') === '/login.html?next=%2F',
  'A raiz protegida não ficou disponível'
);
assert.equal(root.status, 302);
assert.equal(root.headers.get('location'), '/login.html?next=%2F');

const { response: loginPage, body: loginHtml } = await requestUntil(
  '/login.html',
  { redirect: 'manual' },
  (response, body) => response.status === 200 && /id="form-login"/.test(body),
  'A página de login não ficou disponível'
);
assert.equal(loginPage.status, 200);
assert.match(loginHtml, /id="form-login"/);

const { response: anonymousSession, body: anonymousBody } = await requestUntil(
  '/api/session',
  { redirect: 'manual' },
  (response, body) => {
    if (response.status !== 401) return false;
    try {
      return JSON.parse(body).error === 'Sessão inválida ou expirada.';
    } catch {
      return false;
    }
  },
  'O armazenamento de sessões não ficou disponível'
);
assert.equal(anonymousSession.status, 401);
assert.deepEqual(JSON.parse(anonymousBody), {
  ok: false,
  error: 'Sessão inválida ou expirada.'
});

console.log('Produção: página, encaminhamento protegido e armazenamento validados.');
