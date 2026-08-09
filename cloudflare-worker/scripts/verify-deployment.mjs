import assert from 'node:assert/strict';

const deploymentUrl = String(process.env.DEPLOYMENT_URL || '').replace(/\/$/, '');
const rootEmail = String(process.env.DASHBOARD_ROOT_EMAIL || '').trim().toLowerCase();
const initialPassword = String(process.env.DASHBOARD_ROOT_INITIAL_PASSWORD || '');

assert.match(deploymentUrl, /^https:\/\//, 'URL HTTPS da implantação em falta.');
assert.match(rootEmail, /@gmail\.com$/, 'Email do ADMIN principal inválido.');
assert.ok(initialPassword.length >= 12, 'Password inicial em falta.');

const origin = new URL(deploymentUrl).origin;
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

const login = await fetch(`${deploymentUrl}/api/login`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Origin': origin,
    'X-Dashboard-Request': '1'
  },
  body: JSON.stringify({ email: rootEmail, password: initialPassword })
});
assert.equal(login.status, 200, 'O primeiro login real do ADMIN foi recusado.');
const identity = await login.json();
assert.equal(identity.ok, true);
assert.equal(identity.user.email, rootEmail);
assert.equal(identity.user.is_root_admin, true);
assert.equal(identity.user.must_change_password, true);
const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
assert.match(cookie, /^dashboard_session=/);

const authenticatedSession = await fetch(`${deploymentUrl}/api/session`, {
  headers: { Cookie: cookie }
});
assert.equal(authenticatedSession.status, 200);
assert.equal((await authenticatedSession.json()).user.email, rootEmail);

const blockedDashboard = await fetch(`${deploymentUrl}/`, {
  headers: { Cookie: cookie },
  redirect: 'manual'
});
assert.equal(blockedDashboard.status, 302);
assert.equal(blockedDashboard.headers.get('location'), '/login.html?change=1');

console.log('Produção: página, armazenamento e primeiro login ADMIN validados.');
