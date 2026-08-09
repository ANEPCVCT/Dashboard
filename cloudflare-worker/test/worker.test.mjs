import assert from 'node:assert/strict';
import test from 'node:test';

import worker, { UserStore } from '../src/index.js';

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  async get(key) {
    return structuredClone(this.values.get(key));
  }

  async put(key, value, options) {
    assert.equal(options, undefined, 'Durable Object storage.put não aceita opções de expiração');
    this.values.set(key, structuredClone(value));
  }

  async delete(key) {
    this.values.delete(key);
  }

  async list({ prefix = '' } = {}) {
    return new Map(
      [...this.values.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => [key, structuredClone(value)])
    );
  }
}

class TestNamespace {
  constructor(env) {
    const state = { storage: new MemoryStorage() };
    this.instance = new UserStore(state, env);
  }

  getByName() {
    return { fetch: (request) => this.instance.fetch(request) };
  }
}

const rootEmail = 'admin.dashboard@gmail.com';
const initialPassword = 'Temporaria!2026';
const newRootPassword = 'NovaPalavraPasse!2026';

function createEnv() {
  const env = {
    DASHBOARD_ROOT_EMAIL: rootEmail,
    DASHBOARD_ROOT_INITIAL_PASSWORD: initialPassword,
    DASHBOARD_PASSWORD_PEPPER: 'pepper-de-testes-com-pelo-menos-32-caracteres',
    GITHUB_TOKEN: 'token-github-teste',
    GITHUB_OWNER: 'ANEPCVCT',
    GITHUB_REPO: 'Dashboard',
    GITHUB_WORKFLOW: 'atualizar-epe.yml',
    GITHUB_REF: 'main',
    ASSETS: {
      fetch: async (request) => new Response(`<p>${new URL(request.url).pathname}</p>`, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      })
    }
  };
  env.AUTH_STORE = new TestNamespace(env);
  return env;
}

function apiRequest(path, { method = 'GET', body, cookie, csrf } = {}) {
  const headers = new Headers({
    Origin: 'https://worker.test',
    'X-Dashboard-Request': '1'
  });
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (cookie) headers.set('Cookie', cookie);
  if (csrf) headers.set('X-CSRF-Token', csrf);
  return new Request(`https://worker.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

function cookieFrom(response) {
  return (response.headers.get('Set-Cookie') || '').split(';')[0];
}

async function login(env, email, password) {
  const response = await worker.fetch(apiRequest('/api/login', {
    method: 'POST',
    body: { email, password }
  }), env);
  const data = await response.json();
  return { response, data, cookie: cookieFrom(response) };
}

async function changePassword(env, session, currentPassword, newPassword) {
  const response = await worker.fetch(apiRequest('/api/change-password', {
    method: 'POST',
    cookie: session.cookie,
    csrf: session.data.csrf_token,
    body: { current_password: currentPassword, new_password: newPassword }
  }), env);
  return { response, data: await response.json(), cookie: session.cookie };
}

test('Dashboard autenticado', async (suite) => {
  const env = createEnv();
  let rootSession;

  await suite.test('cria apenas o ADMIN Gmail e obriga a alterar a palavra-passe', async () => {
    rootSession = await login(env, rootEmail, initialPassword);
    assert.equal(rootSession.response.status, 200);
    assert.equal(rootSession.data.user.is_root_admin, true);
    assert.equal(rootSession.data.user.must_change_password, true);
    assert.deepEqual(rootSession.data.user.permissions, {
      view_dashboard: true,
      manage_epe: true,
      manage_users: true,
      view_contacts: true,
      manage_contacts: true,
      view_knowledge: true,
      manage_knowledge: true
    });

    const protectedPage = await worker.fetch(new Request('https://worker.test/', {
      headers: { Cookie: rootSession.cookie }
    }), env);
    assert.equal(protectedPage.status, 302);
    assert.equal(protectedPage.headers.get('Location'), '/login.html?change=1');
  });

  await suite.test('recusa a palavra-passe atual errada e aceita uma nova', async () => {
    const wrong = await changePassword(env, rootSession, 'ErradaErrada!2026', newRootPassword);
    assert.equal(wrong.response.status, 400);

    rootSession = await changePassword(env, rootSession, initialPassword, newRootPassword);
    assert.equal(rootSession.response.status, 200);
    assert.equal(rootSession.data.user.must_change_password, false);

    const protectedPage = await worker.fetch(new Request('https://worker.test/', {
      headers: { Cookie: rootSession.cookie }
    }), env);
    assert.equal(protectedPage.status, 200);
    assert.match(await protectedPage.text(), /<p>\/<\/p>/);

    const dashboardPage = await worker.fetch(new Request('https://worker.test/dashboard.html', {
      headers: { Cookie: rootSession.cookie }
    }), env);
    assert.equal(dashboardPage.status, 200);
    assert.match(await dashboardPage.text(), /<p>\/dashboard\.html<\/p>/);
  });

  await suite.test('recusa contas fora de @prociv.pt', async () => {
    const response = await worker.fetch(apiRequest('/api/admin/users', {
      method: 'POST',
      cookie: rootSession.cookie,
      csrf: rootSession.data.csrf_token,
      body: {
        email: 'outro@gmail.com',
        display_name: 'Conta inválida',
        temporary_password: 'Temporaria!2026',
        permissions: { view_dashboard: true }
      }
    }), env);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /@prociv\.pt/);
  });

  await suite.test('cria a conta institucional com permissões independentes', async () => {
    const response = await worker.fetch(apiRequest('/api/admin/users', {
      method: 'POST',
      cookie: rootSession.cookie,
      csrf: rootSession.data.csrf_token,
      body: {
        email: 'joao.silverio@prociv.pt',
        display_name: 'João Silvério',
        temporary_password: 'Institucional!2026',
        permissions: {
          view_dashboard: true,
          manage_epe: true,
          manage_users: true,
          view_contacts: true,
          manage_contacts: true,
          view_knowledge: true,
          manage_knowledge: true
        }
      }
    }), env);
    const data = await response.json();
    assert.equal(response.status, 201);
    assert.equal(data.user.email, 'joao.silverio@prociv.pt');
    assert.equal(data.user.must_change_password, true);
    assert.equal(data.user.permissions.manage_users, true);
    assert.equal(data.user.permissions.manage_contacts, true);
    assert.equal(data.user.permissions.manage_knowledge, true);
  });

  await suite.test('a conta institucional também é bloqueada até mudar a password', async () => {
    let session = await login(env, 'joao.silverio@prociv.pt', 'Institucional!2026');
    assert.equal(session.response.status, 200);
    assert.equal(session.data.user.must_change_password, true);

    const usersBeforeChange = await worker.fetch(apiRequest('/api/admin/users', {
      cookie: session.cookie
    }), env);
    assert.equal(usersBeforeChange.status, 428);

    session = await changePassword(
      env,
      session,
      'Institucional!2026',
      'PessoalSegura!2026'
    );
    assert.equal(session.response.status, 200);

    const usersAfterChange = await worker.fetch(apiRequest('/api/admin/users', {
      cookie: session.cookie
    }), env);
    assert.equal(usersAfterChange.status, 200);
  });

  await suite.test('uma conta Dashboard não consegue gerir EPE', async () => {
    const create = await worker.fetch(apiRequest('/api/admin/users', {
      method: 'POST',
      cookie: rootSession.cookie,
      csrf: rootSession.data.csrf_token,
      body: {
        email: 'consulta@prociv.pt',
        display_name: 'Consulta Dashboard',
        temporary_password: 'ConsultaTemp!2026',
        permissions: { view_dashboard: true, manage_epe: false, manage_users: false }
      }
    }), env);
    assert.equal(create.status, 201);

    let session = await login(env, 'consulta@prociv.pt', 'ConsultaTemp!2026');
    session = await changePassword(env, session, 'ConsultaTemp!2026', 'ConsultaFinal!2026');
    const response = await worker.fetch(apiRequest('/api/epe', {
      method: 'POST',
      cookie: session.cookie,
      csrf: session.data.csrf_token,
      body: { versao: 1, timezone: 'Europe/Lisbon', agendamentos: [] }
    }), env);
    assert.equal(response.status, 403);
  });

  await suite.test('uma conta da Lista Telefónica entra no Portal sem abrir o Dashboard', async () => {
    const create = await worker.fetch(apiRequest('/api/admin/users', {
      method: 'POST',
      cookie: rootSession.cookie,
      csrf: rootSession.data.csrf_token,
      body: {
        email: 'contactos@prociv.pt',
        display_name: 'Consulta de Contactos',
        temporary_password: 'ContactosTemp!2026',
        permissions: { view_contacts: true }
      }
    }), env);
    assert.equal(create.status, 201);

    let session = await login(env, 'contactos@prociv.pt', 'ContactosTemp!2026');
    session = await changePassword(env, session, 'ContactosTemp!2026', 'ContactosFinal!2026');

    const portal = await worker.fetch(new Request('https://worker.test/', {
      headers: { Cookie: session.cookie }
    }), env);
    assert.equal(portal.status, 200);

    const dashboard = await worker.fetch(new Request('https://worker.test/dashboard.html', {
      headers: { Cookie: session.cookie }
    }), env);
    assert.equal(dashboard.status, 403);
  });

  await suite.test('uma conta Operador gere EPE sem chave adicional', async () => {
    const create = await worker.fetch(apiRequest('/api/admin/users', {
      method: 'POST',
      cookie: rootSession.cookie,
      csrf: rootSession.data.csrf_token,
      body: {
        email: 'operador@prociv.pt',
        display_name: 'Operador EPE',
        temporary_password: 'OperadorTemp!2026',
        permissions: { view_dashboard: false, manage_epe: true, manage_users: false }
      }
    }), env);
    assert.equal(create.status, 201);

    let session = await login(env, 'operador@prociv.pt', 'OperadorTemp!2026');
    session = await changePassword(env, session, 'OperadorTemp!2026', 'OperadorFinal!2026');

    const originalFetch = globalThis.fetch;
    let captured;
    globalThis.fetch = async (url, options) => {
      captured = { url, options };
      return new Response(null, { status: 204 });
    };
    try {
      const response = await worker.fetch(apiRequest('/api/epe', {
        method: 'POST',
        cookie: session.cookie,
        csrf: session.data.csrf_token,
        body: { versao: 1, timezone: 'Europe/Lisbon', agendamentos: [] }
      }), env);
      assert.equal(response.status, 202);
      assert.equal(captured.options.headers.Authorization, 'Bearer token-github-teste');
      const dispatch = JSON.parse(JSON.parse(captured.options.body).inputs.epe_payload);
      assert.equal(dispatch.operador, 'operador@prociv.pt');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await suite.test('protege a conta ADMIN principal contra alterações', async () => {
    const response = await worker.fetch(apiRequest(
      `/api/admin/users/${encodeURIComponent(rootEmail)}`,
      {
        method: 'PUT',
        cookie: rootSession.cookie,
        csrf: rootSession.data.csrf_token,
        body: {
          display_name: 'Desativado',
          active: false,
          permissions: {}
        }
      }
    ), env);
    assert.equal(response.status, 403);
  });

  await suite.test('não aceita pedidos mutáveis sem proteção de sessão', async () => {
    const response = await worker.fetch(new Request('https://worker.test/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    }), env);
    assert.equal(response.status, 403);
  });
});

test('erros assíncronos do armazenamento são convertidos numa resposta controlada', async () => {
  const env = createEnv();
  env.DASHBOARD_PASSWORD_PEPPER = 'curto';
  const response = await worker.fetch(apiRequest('/api/session'), env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: 'O serviço de contas não está disponível. Tente novamente.'
  });
});
