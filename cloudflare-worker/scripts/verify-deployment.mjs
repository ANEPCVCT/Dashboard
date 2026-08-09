import assert from 'node:assert/strict';

const deploymentUrl = String(process.env.DEPLOYMENT_URL || '').replace(/\/$/, '');
const rootEmail = String(process.env.DASHBOARD_ROOT_EMAIL || '').trim().toLowerCase();
const initialPassword = String(process.env.DASHBOARD_ROOT_INITIAL_PASSWORD || '');

assert.match(deploymentUrl, /^https:\/\//, 'URL HTTPS da implantação em falta.');
assert.match(rootEmail, /@gmail\.com$/, 'Email do ADMIN principal inválido.');
assert.ok(initialPassword.length >= 12, 'Password inicial em falta.');

const origin = new URL(deploymentUrl).origin;
const health = await fetch(`${deploymentUrl}/health`);
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), { ok: true, service: 'dashboard-anepc' });

const root = await fetch(`${deploymentUrl}/`, { redirect: 'manual' });
assert.equal(root.status, 302);
assert.equal(root.headers.get('location'), '/login.html?next=%2F');

const loginPage = await fetch(`${deploymentUrl}/login.html`, { redirect: 'manual' });
assert.equal(loginPage.status, 200);
assert.match(await loginPage.text(), /id="form-login"/);

const anonymousSession = await fetch(`${deploymentUrl}/api/session`);
assert.equal(anonymousSession.status, 401);
assert.deepEqual(await anonymousSession.json(), {
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

console.log('Produção: página de login, armazenamento e autenticação ADMIN validados.');
