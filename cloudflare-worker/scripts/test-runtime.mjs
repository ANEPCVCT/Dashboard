import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const host = '127.0.0.1';
const port = 8791;
const origin = `http://${host}:${port}`;
const rootEmail = 'admin.runtime@gmail.com';
const initialPassword = 'TemporariaRuntime!2026';
const stateDirectory = await mkdtemp(join(tmpdir(), 'dashboard-anepc-runtime-'));
const wrangler = join(process.cwd(), 'node_modules', 'wrangler', 'bin', 'wrangler.js');
let logs = '';

const child = spawn(process.execPath, [
  wrangler,
  'dev',
  '--local',
  '--ip', host,
  '--port', String(port),
  '--persist-to', stateDirectory,
  '--show-interactive-dev-session=false',
  '--log-level=error',
  '--var', `DASHBOARD_ROOT_EMAIL:${rootEmail}`,
  '--var', `DASHBOARD_ROOT_INITIAL_PASSWORD:${initialPassword}`,
  '--var', 'DASHBOARD_PASSWORD_PEPPER:pepper-runtime-seguro-com-mais-de-32-caracteres',
  '--var', 'GITHUB_TOKEN:token-runtime-nao-utilizado'
], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    WRANGLER_LOG_PATH: join(stateDirectory, 'wrangler.log')
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => { logs += chunk; });
}

async function waitForWorker() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`workerd terminou prematuramente.\n${logs}`);
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return;
    } catch {
      // O porto ainda não está disponível.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`workerd não ficou disponível dentro do prazo.\n${logs}`);
}

function cookieFrom(response) {
  return (response.headers.get('set-cookie') || '').split(';')[0];
}

try {
  await waitForWorker();

  const root = await fetch(`${origin}/`, { redirect: 'manual' });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/login.html?next=%2F');

  const loginPage = await fetch(`${origin}/login.html`, { redirect: 'manual' });
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /id="form-login"/);

  const anonymousSession = await fetch(`${origin}/api/session`);
  assert.equal(anonymousSession.status, 401);

  const login = await fetch(`${origin}/api/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': origin,
      'X-Dashboard-Request': '1'
    },
    body: JSON.stringify({ email: rootEmail, password: initialPassword })
  });
  assert.equal(login.status, 200);
  const identity = await login.json();
  assert.equal(identity.ok, true);
  assert.equal(identity.user.email, rootEmail);
  assert.equal(identity.user.is_root_admin, true);
  assert.equal(identity.user.must_change_password, true);
  const cookie = cookieFrom(login);
  assert.match(cookie, /^dashboard_session=/);

  const session = await fetch(`${origin}/api/session`, { headers: { Cookie: cookie } });
  assert.equal(session.status, 200);
  assert.equal((await session.json()).user.email, rootEmail);

  const blockedDashboard = await fetch(`${origin}/`, {
    headers: { Cookie: cookie },
    redirect: 'manual'
  });
  assert.equal(blockedDashboard.status, 302);
  assert.equal(blockedDashboard.headers.get('location'), '/login.html?change=1');

  const changePassword = await fetch(`${origin}/api/change-password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookie,
      'Origin': origin,
      'X-Dashboard-Request': '1',
      'X-CSRF-Token': identity.csrf_token
    },
    body: JSON.stringify({
      current_password: initialPassword,
      new_password: 'NovaRuntimeSegura!2026'
    })
  });
  assert.equal(changePassword.status, 200);
  assert.equal((await changePassword.json()).user.must_change_password, false);

  const portal = await fetch(`${origin}/`, { headers: { Cookie: cookie } });
  assert.equal(portal.status, 200);
  assert.match(await portal.text(), /id="titulo-modulos"/);

  const dashboard = await fetch(`${origin}/dashboard.html`, { headers: { Cookie: cookie } });
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /id="dashboard-grid"/);

  console.log('Runtime workerd: login, Portal, Dashboard, Durable Object e sessão validados.');
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000))
  ]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  }
  await rm(stateDirectory, { recursive: true, force: true });
}
