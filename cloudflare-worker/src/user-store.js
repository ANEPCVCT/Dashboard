import {
  LOGIN_BLOCK_MS,
  LOGIN_WINDOW_MS,
  MAX_IP_ATTEMPTS,
  MAX_USER_ATTEMPTS,
  PBKDF2_ITERATIONS,
  SESSION_DURATION_MS,
  clearSessionCookie,
  createPasswordRecord,
  hasAnyPermission,
  normalizeEmail,
  parseCookies,
  permissionsFrom,
  publicUser,
  randomToken,
  readJson,
  sessionCookie,
  sha256Text,
  validateDisplayName,
  validatePassword,
  verifyPassword
} from './auth.js';

const USER_PREFIX = 'user:';
const SESSION_PREFIX = 'session:';
const RATE_PREFIX = 'rate:';
const AUDIT_PREFIX = 'audit:';
const MAX_USERS = 200;

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers
    }
  });
}

function nowIso() {
  return new Date().toISOString();
}

function timestamp(value) {
  const result = new Date(value || 0).getTime();
  return Number.isFinite(result) ? result : 0;
}

function userKey(email) {
  return `${USER_PREFIX}${normalizeEmail(email)}`;
}

function genericLoginError() {
  return json(401, {
    ok: false,
    error: 'Email ou palavra-passe incorretos.'
  });
}

function permissionAllowed(user, permission) {
  const permissions = permissionsFrom(user.permissions);
  if (permission === 'access') return hasAnyPermission(permissions);
  if (permission === 'view_epe') return permissions.view_dashboard || permissions.manage_epe;
  if (permission === 'access_dashboard') {
    return permissions.view_dashboard || permissions.manage_epe || permissions.manage_users;
  }
  if (permission === 'access_contacts') {
    return permissions.view_contacts || permissions.manage_contacts;
  }
  if (permission === 'access_knowledge') {
    return permissions.view_knowledge || permissions.manage_knowledge;
  }
  if (permission === 'view_dashboard') return permissions.view_dashboard;
  if (permission === 'manage_epe') return permissions.manage_epe;
  if (permission === 'manage_users') return permissions.manage_users;
  if (permission === 'view_contacts') return permissions.view_contacts;
  if (permission === 'manage_contacts') return permissions.manage_contacts;
  if (permission === 'view_knowledge') return permissions.view_knowledge;
  if (permission === 'manage_knowledge') return permissions.manage_knowledge;
  return false;
}

function rootPermissions() {
  return {
    view_dashboard: true,
    manage_epe: true,
    manage_users: true,
    view_contacts: true,
    manage_contacts: true,
    view_knowledge: true,
    manage_knowledge: true
  };
}

export class UserStore {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
  }

  rootEmail() {
    return normalizeEmail(this.env.DASHBOARD_ROOT_EMAIL);
  }

  async ensureRootUser() {
    const email = this.rootEmail();
    const password = String(this.env.DASHBOARD_ROOT_INITIAL_PASSWORD || '');

    if (!email.endsWith('@gmail.com')) {
      throw new Error('DASHBOARD_ROOT_EMAIL deve identificar a conta Gmail do ADMIN principal.');
    }
    if (!password) {
      throw new Error('DASHBOARD_ROOT_INITIAL_PASSWORD não está configurada.');
    }

    const key = userKey(email);
    let user = await this.storage.get(key);
    if (!user) {
      const passwordRecord = await createPasswordRecord(password, this.env.DASHBOARD_PASSWORD_PEPPER);
      const createdAt = nowIso();
      user = {
        email,
        display_name: 'ADMIN principal',
        ...passwordRecord,
        must_change_password: true,
        permissions: rootPermissions(),
        is_root_admin: true,
        active: true,
        failed_attempts: 0,
        locked_until: null,
        session_epoch: 1,
        created_at: createdAt,
        updated_at: createdAt,
        created_by: 'bootstrap',
        last_login_at: null
      };
      await this.storage.put(key, user);
      await this.audit('bootstrap', 'create_root_admin', email, null, publicUser(user, email));
      return user;
    }

    const protectedUser = {
      ...user,
      email,
      is_root_admin: true,
      active: true,
      permissions: rootPermissions()
    };
    if (JSON.stringify(protectedUser) !== JSON.stringify(user)) {
      protectedUser.updated_at = nowIso();
      await this.storage.put(key, protectedUser);
    }
    return protectedUser;
  }

  async audit(actor, action, target, before, after) {
    const createdAt = nowIso();
    const key = `${AUDIT_PREFIX}${createdAt}:${randomToken(8)}`;
    await this.storage.put(key, { actor, action, target, before, after, created_at: createdAt });
  }

  async getUser(email) {
    return this.storage.get(userKey(email));
  }

  async getSession(request) {
    const rawToken = parseCookies(request).dashboard_session;
    if (!rawToken) return null;
    const tokenHash = await sha256Text(rawToken);
    const key = `${SESSION_PREFIX}${tokenHash}`;
    const session = await this.storage.get(key);
    if (!session || timestamp(session.expires_at) <= Date.now()) {
      if (session) await this.storage.delete(key);
      return null;
    }
    const user = await this.getUser(session.email);
    if (!user || user.active !== true || Number(user.session_epoch) !== Number(session.session_epoch)) {
      await this.storage.delete(key);
      return null;
    }
    return { rawToken, tokenHash, key, session, user };
  }

  async createSession(user) {
    const rawToken = randomToken(32);
    const tokenHash = await sha256Text(rawToken);
    const csrfToken = randomToken(24);
    const createdAt = nowIso();
    const session = {
      email: user.email,
      csrf_token: csrfToken,
      session_epoch: Number(user.session_epoch) || 1,
      created_at: createdAt,
      expires_at: new Date(Date.now() + SESSION_DURATION_MS).toISOString()
    };
    await this.storage.put(`${SESSION_PREFIX}${tokenHash}`, session);
    return { rawToken, csrfToken, session };
  }

  async requireSession(request, permission = 'access', unsafe = false) {
    const current = await this.getSession(request);
    if (!current) return { response: json(401, { ok: false, error: 'Sessão inválida ou expirada.' }) };
    if (current.user.must_change_password === true && permission !== 'change_password') {
      return {
        response: json(428, {
          ok: false,
          must_change_password: true,
          error: 'É obrigatório alterar a palavra-passe provisória.'
        })
      };
    }
    if (!permissionAllowed(current.user, permission) && permission !== 'change_password') {
      return { response: json(403, { ok: false, error: 'A conta não tem permissão para esta operação.' }) };
    }
    if (unsafe) {
      const supplied = request.headers.get('X-CSRF-Token') || '';
      if (!supplied || supplied !== current.session.csrf_token) {
        return { response: json(403, { ok: false, error: 'Proteção de sessão inválida.' }) };
      }
    }
    return { ...current, response: null };
  }

  async rateStatus(request, email) {
    const clientIp = request.headers.get('X-Client-IP') || 'unknown';
    const ipHash = await sha256Text(clientIp);
    const key = `${RATE_PREFIX}${ipHash}`;
    const current = await this.storage.get(key) || {
      attempts: 0,
      window_started_at: nowIso(),
      blocked_until: null
    };
    const now = Date.now();
    if (timestamp(current.blocked_until) > now) return { blocked: true, key, current };
    if (now - timestamp(current.window_started_at) > LOGIN_WINDOW_MS) {
      current.attempts = 0;
      current.window_started_at = nowIso();
      current.blocked_until = null;
    }
    const user = await this.getUser(email);
    const userBlocked = user && timestamp(user.locked_until) > now;
    return { blocked: Boolean(userBlocked), key, current, user };
  }

  async recordLoginFailure(rate, user) {
    const current = { ...rate.current, attempts: Number(rate.current.attempts || 0) + 1 };
    if (current.attempts >= MAX_IP_ATTEMPTS) {
      current.blocked_until = new Date(Date.now() + LOGIN_BLOCK_MS).toISOString();
    }
    await this.storage.put(rate.key, current);

    if (user) {
      const failed = Number(user.failed_attempts || 0) + 1;
      const updated = {
        ...user,
        failed_attempts: failed,
        locked_until: failed >= MAX_USER_ATTEMPTS
          ? new Date(Date.now() + LOGIN_BLOCK_MS).toISOString()
          : user.locked_until,
        updated_at: nowIso()
      };
      await this.storage.put(userKey(user.email), updated);
    }
  }

  async login(request) {
    await this.ensureRootUser();
    let body;
    try {
      body = await readJson(request, 8 * 1024);
    } catch (error) {
      return json(400, { ok: false, error: error.message });
    }
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');
    const rate = await this.rateStatus(request, email);
    if (rate.blocked) {
      return json(429, {
        ok: false,
        error: 'Foram efetuadas demasiadas tentativas. Aguarde 15 minutos e tente novamente.'
      });
    }

    const user = rate.user;
    let valid = false;
    if (user && user.active === true) {
      valid = await verifyPassword(password, user, this.env.DASHBOARD_PASSWORD_PEPPER);
    } else {
      const dummy = {
        password_salt: 'ZGFzaGJvYXJkLWFuZXBjLWR1bW15',
        password_iterations: PBKDF2_ITERATIONS,
        password_hash: 'invalid'
      };
      await verifyPassword(password, dummy, this.env.DASHBOARD_PASSWORD_PEPPER);
    }

    if (!valid) {
      await this.recordLoginFailure(rate, user);
      return genericLoginError();
    }

    const updated = {
      ...user,
      failed_attempts: 0,
      locked_until: null,
      last_login_at: nowIso(),
      updated_at: nowIso()
    };
    await this.storage.put(userKey(email), updated);
    await this.storage.delete(rate.key);
    const session = await this.createSession(updated);
    await this.audit(email, 'login', email, null, null);
    return json(200, {
      ok: true,
      user: publicUser(updated, this.rootEmail()),
      csrf_token: session.csrfToken
    }, { 'Set-Cookie': sessionCookie(session.rawToken) });
  }

  async session(request) {
    await this.ensureRootUser();
    const current = await this.getSession(request);
    if (!current) return json(401, { ok: false, error: 'Sessão inválida ou expirada.' });
    return json(200, {
      ok: true,
      user: publicUser(current.user, this.rootEmail()),
      csrf_token: current.session.csrf_token
    });
  }

  async logout(request) {
    const current = await this.getSession(request);
    if (current) {
      await this.storage.delete(current.key);
      await this.audit(current.user.email, 'logout', current.user.email, null, null);
    }
    return json(200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
  }

  async changePassword(request) {
    const current = await this.requireSession(request, 'change_password', true);
    if (current.response) return current.response;
    let body;
    try {
      body = await readJson(request, 8 * 1024);
      validatePassword(body.current_password);
      validatePassword(body.new_password);
    } catch (error) {
      return json(400, { ok: false, error: error.message });
    }
    if (!(await verifyPassword(body.current_password, current.user, this.env.DASHBOARD_PASSWORD_PEPPER))) {
      return json(400, { ok: false, error: 'A palavra-passe atual está incorreta.' });
    }
    if (body.current_password === body.new_password) {
      return json(400, { ok: false, error: 'A nova palavra-passe tem de ser diferente da provisória.' });
    }
    const passwordRecord = await createPasswordRecord(
      body.new_password,
      this.env.DASHBOARD_PASSWORD_PEPPER
    );
    const updated = {
      ...current.user,
      ...passwordRecord,
      must_change_password: false,
      session_epoch: Number(current.user.session_epoch || 1) + 1,
      failed_attempts: 0,
      locked_until: null,
      password_changed_at: nowIso(),
      updated_at: nowIso()
    };
    const session = {
      ...current.session,
      session_epoch: updated.session_epoch,
      expires_at: new Date(Date.now() + SESSION_DURATION_MS).toISOString()
    };
    await this.storage.put(userKey(updated.email), updated);
    await this.storage.put(current.key, session);
    await this.audit(updated.email, 'change_password', updated.email, null, null);
    return json(200, {
      ok: true,
      user: publicUser(updated, this.rootEmail()),
      csrf_token: session.csrf_token
    });
  }

  async authorize(request, url) {
    const permission = url.searchParams.get('permission') || 'access';
    const unsafe = url.searchParams.get('unsafe') === '1';
    const current = await this.requireSession(request, permission, unsafe);
    if (current.response) return current.response;
    return json(200, {
      ok: true,
      user: publicUser(current.user, this.rootEmail()),
      csrf_token: current.session.csrf_token
    });
  }

  validateInstitutionalEmail(email) {
    const normalized = normalizeEmail(email);
    if (!normalized.endsWith('@prociv.pt')) {
      throw new Error('As contas criadas têm obrigatoriamente de usar um email @prociv.pt.');
    }
    return normalized;
  }

  async listUsers(request) {
    const current = await this.requireSession(request, 'manage_users');
    if (current.response) return current.response;
    const entries = await this.storage.list({ prefix: USER_PREFIX });
    const users = [...entries.values()]
      .map((user) => publicUser(user, this.rootEmail()))
      .sort((a, b) => Number(b.is_root_admin) - Number(a.is_root_admin) || a.email.localeCompare(b.email));
    return json(200, { ok: true, users });
  }

  async createUser(request) {
    const current = await this.requireSession(request, 'manage_users', true);
    if (current.response) return current.response;
    let body;
    let email;
    let displayName;
    let temporaryPassword;
    let permissions;
    try {
      body = await readJson(request);
      email = this.validateInstitutionalEmail(body.email);
      displayName = validateDisplayName(body.display_name);
      temporaryPassword = validatePassword(body.temporary_password);
      permissions = permissionsFrom(body.permissions);
      if (!hasAnyPermission(permissions)) {
        throw new Error('Selecione pelo menos uma permissão para a conta.');
      }
    } catch (error) {
      return json(400, { ok: false, error: error.message });
    }
    if (await this.getUser(email)) {
      return json(409, { ok: false, error: 'Já existe uma conta com esse email.' });
    }
    const entries = await this.storage.list({ prefix: USER_PREFIX });
    if (entries.size >= MAX_USERS) {
      return json(409, { ok: false, error: 'Foi atingido o limite de contas configurado.' });
    }
    const passwordRecord = await createPasswordRecord(
      temporaryPassword,
      this.env.DASHBOARD_PASSWORD_PEPPER
    );
    const createdAt = nowIso();
    const user = {
      email,
      display_name: displayName,
      ...passwordRecord,
      must_change_password: true,
      permissions,
      is_root_admin: false,
      active: true,
      failed_attempts: 0,
      locked_until: null,
      session_epoch: 1,
      created_at: createdAt,
      updated_at: createdAt,
      created_by: current.user.email,
      last_login_at: null
    };
    await this.storage.put(userKey(email), user);
    await this.audit(current.user.email, 'create_user', email, null, publicUser(user, this.rootEmail()));
    return json(201, { ok: true, user: publicUser(user, this.rootEmail()) });
  }

  async updateUser(request, targetEmail) {
    const current = await this.requireSession(request, 'manage_users', true);
    if (current.response) return current.response;
    const email = normalizeEmail(targetEmail);
    if (email === this.rootEmail()) {
      return json(403, { ok: false, error: 'A conta ADMIN principal está protegida.' });
    }
    const existing = await this.getUser(email);
    if (!existing) return json(404, { ok: false, error: 'Conta não encontrada.' });
    let body;
    let displayName;
    let permissions;
    let active;
    try {
      body = await readJson(request);
      displayName = validateDisplayName(body.display_name);
      permissions = permissionsFrom(body.permissions);
      active = body.active === true;
      if (active && !hasAnyPermission(permissions)) {
        throw new Error('Selecione pelo menos uma permissão para uma conta ativa.');
      }
    } catch (error) {
      return json(400, { ok: false, error: error.message });
    }
    const updated = {
      ...existing,
      display_name: displayName,
      permissions,
      active,
      session_epoch: active === existing.active
        ? existing.session_epoch
        : Number(existing.session_epoch || 1) + 1,
      updated_at: nowIso()
    };
    await this.storage.put(userKey(email), updated);
    await this.audit(
      current.user.email,
      'update_user',
      email,
      publicUser(existing, this.rootEmail()),
      publicUser(updated, this.rootEmail())
    );
    return json(200, { ok: true, user: publicUser(updated, this.rootEmail()) });
  }

  async resetPassword(request, targetEmail) {
    const current = await this.requireSession(request, 'manage_users', true);
    if (current.response) return current.response;
    const email = normalizeEmail(targetEmail);
    if (email === this.rootEmail()) {
      return json(403, { ok: false, error: 'A palavra-passe do ADMIN principal só pode ser alterada na própria sessão.' });
    }
    const existing = await this.getUser(email);
    if (!existing) return json(404, { ok: false, error: 'Conta não encontrada.' });
    let body;
    let temporaryPassword;
    try {
      body = await readJson(request);
      temporaryPassword = validatePassword(body.temporary_password);
    } catch (error) {
      return json(400, { ok: false, error: error.message });
    }
    const passwordRecord = await createPasswordRecord(
      temporaryPassword,
      this.env.DASHBOARD_PASSWORD_PEPPER
    );
    const updated = {
      ...existing,
      ...passwordRecord,
      must_change_password: true,
      failed_attempts: 0,
      locked_until: null,
      session_epoch: Number(existing.session_epoch || 1) + 1,
      updated_at: nowIso()
    };
    await this.storage.put(userKey(email), updated);
    await this.audit(current.user.email, 'reset_password', email, null, null);
    return json(200, { ok: true, user: publicUser(updated, this.rootEmail()) });
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (request.method === 'POST' && url.pathname === '/login') return await this.login(request);
      if (request.method === 'GET' && url.pathname === '/session') return await this.session(request);
      if (request.method === 'POST' && url.pathname === '/logout') return await this.logout(request);
      if (request.method === 'POST' && url.pathname === '/change-password') {
        return await this.changePassword(request);
      }
      if (request.method === 'GET' && url.pathname === '/authorize') return await this.authorize(request, url);
      if (request.method === 'GET' && url.pathname === '/users') return await this.listUsers(request);
      if (request.method === 'POST' && url.pathname === '/users') return await this.createUser(request);

      const resetMatch = url.pathname.match(/^\/users\/([^/]+)\/reset-password$/);
      if (request.method === 'POST' && resetMatch) {
        return await this.resetPassword(request, decodeURIComponent(resetMatch[1]));
      }
      const userMatch = url.pathname.match(/^\/users\/([^/]+)$/);
      if (request.method === 'PUT' && userMatch) {
        return await this.updateUser(request, decodeURIComponent(userMatch[1]));
      }
      return json(404, { ok: false, error: 'Operação de autenticação não encontrada.' });
    } catch (error) {
      console.error('Falha no armazenamento de utilizadores.', error);
      return json(503, {
        ok: false,
        error: 'O serviço de contas não está disponível. Tente novamente.'
      });
    }
  }
}
