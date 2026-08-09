export const PBKDF2_ITERATIONS = 600_000;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_BLOCK_MS = 15 * 60 * 1000;
export const MAX_IP_ATTEMPTS = 10;
export const MAX_USER_ATTEMPTS = 5;

const encoder = new TextEncoder();

export function normalizeEmail(value) {
  return String(value || '').trim().toLocaleLowerCase('en-US');
}

export function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
}

export function validatePassword(password) {
  const value = String(password || '');
  const length = Array.from(value).length;

  if (length < PASSWORD_MIN_LENGTH) {
    throw new Error(`A palavra-passe deve ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`);
  }
  if (length > PASSWORD_MAX_LENGTH || encoder.encode(value).byteLength > 512) {
    throw new Error(`A palavra-passe não pode exceder ${PASSWORD_MAX_LENGTH} caracteres.`);
  }
  if (/^\s+$/.test(value)) {
    throw new Error('A palavra-passe não pode ser composta apenas por espaços.');
  }

  return value;
}

export function validateDisplayName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 100) {
    throw new Error('O nome deve ter entre 2 e 100 caracteres.');
  }
  return name;
}

export function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function fromBase64Url(value) {
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function randomToken(size = 32) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

export async function sha256Text(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(value || '')));
  return toBase64Url(new Uint8Array(digest));
}

export async function derivePasswordHash(password, salt, pepper, iterations = PBKDF2_ITERATIONS) {
  const checked = validatePassword(password);
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(`${checked}\u0000${String(pepper || '')}`),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt: fromBase64Url(salt),
    iterations
  }, material, 256);
  return toBase64Url(new Uint8Array(bits));
}

export async function createPasswordRecord(password, pepper) {
  if (!pepper || String(pepper).length < 32) {
    throw new Error('O segredo de proteção das palavras-passe não está configurado.');
  }
  const salt = randomToken(16);
  return {
    password_hash: await derivePasswordHash(password, salt, pepper),
    password_salt: salt,
    password_iterations: PBKDF2_ITERATIONS
  };
}

export async function constantTimeEqual(left, right) {
  const a = encoder.encode(String(left || ''));
  const b = encoder.encode(String(right || ''));
  if (a.length !== b.length) return false;
  if (typeof crypto.subtle.timingSafeEqual === 'function') {
    return crypto.subtle.timingSafeEqual(a, b);
  }
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

export async function verifyPassword(password, user, pepper) {
  try {
    const candidate = await derivePasswordHash(
      password,
      user.password_salt,
      pepper,
      Number(user.password_iterations) || PBKDF2_ITERATIONS
    );
    return constantTimeEqual(candidate, user.password_hash);
  } catch {
    return false;
  }
}

export function parseCookies(request) {
  const result = {};
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    result[part.slice(0, separator).trim()] = decodeURIComponent(part.slice(separator + 1).trim());
  }
  return result;
}

export function sessionCookie(token, maxAgeSeconds = SESSION_DURATION_MS / 1000) {
  return [
    `dashboard_session=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${Math.floor(maxAgeSeconds)}`,
    'HttpOnly',
    'Secure',
    'SameSite=Strict'
  ].join('; ');
}

export function clearSessionCookie() {
  return 'dashboard_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict';
}

export function permissionsFrom(value = {}) {
  return {
    view_dashboard: value.view_dashboard === true,
    manage_epe: value.manage_epe === true,
    manage_users: value.manage_users === true
  };
}

export function hasAnyPermission(permissions) {
  return Boolean(
    permissions.view_dashboard || permissions.manage_epe || permissions.manage_users
  );
}

export function publicUser(user, rootEmail = '') {
  return {
    email: user.email,
    display_name: user.display_name,
    active: user.active === true,
    must_change_password: user.must_change_password === true,
    is_root_admin: user.email === rootEmail || user.is_root_admin === true,
    permissions: permissionsFrom(user.permissions),
    created_at: user.created_at,
    updated_at: user.updated_at,
    last_login_at: user.last_login_at || null
  };
}

export async function readJson(request, maxBytes = 16 * 1024) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > maxBytes) throw new Error('O pedido excede o tamanho permitido.');
  const text = await request.text();
  if (encoder.encode(text).byteLength > maxBytes) {
    throw new Error('O pedido excede o tamanho permitido.');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('O pedido contém JSON inválido.');
  }
}

