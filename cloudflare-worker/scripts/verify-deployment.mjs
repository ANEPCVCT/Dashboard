import assert from 'node:assert/strict';

const deploymentUrl = String(process.env.DEPLOYMENT_URL || '').replace(/\/$/, '');

assert.match(deploymentUrl, /^https:\/\//, 'URL HTTPS da implantação em falta.');
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

console.log('Produção: saúde, página de login e armazenamento de sessões validados.');
