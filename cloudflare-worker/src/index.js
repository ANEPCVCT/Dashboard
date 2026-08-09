import { readJson } from './auth.js';
import { UserStore } from './user-store.js';

export { UserStore };

const MAX_BODY_BYTES = 16 * 1024;
const DEFAULT_GITHUB_OWNER = 'ANEPCVCT';
const DEFAULT_GITHUB_REPO = 'Dashboard';
const DEFAULT_GITHUB_WORKFLOW = 'atualizar-epe.yml';
const DEFAULT_GITHUB_REF = 'main';
const PUBLIC_ASSETS = new Set(['/login.html', '/anepc_logo.png', '/favicon.ico']);
const API_ROUTE_MAP = new Map([
  ['/api/login', '/login'],
  ['/api/session', '/session'],
  ['/api/logout', '/logout'],
  ['/api/change-password', '/change-password'],
  ['/api/admin/users', '/users']
]);

function jsonResponse(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders
    }
  });
}

function authStub(env) {
  return env.AUTH_STORE.getByName('dashboard-anepc-users');
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

function validateSameOrigin(request) {
  const origin = request.headers.get('Origin');
  const expected = new URL(request.url).origin;
  const requestedWith = request.headers.get('X-Dashboard-Request');
  return origin === expected && requestedWith === '1';
}

async function internalRequest(request, pathname) {
  const url = new URL(request.url);
  url.hostname = 'auth.internal';
  url.protocol = 'https:';
  url.pathname = pathname;
  const headers = new Headers(request.headers);
  headers.set('X-Client-IP', clientIp(request));
  const body = ['GET', 'HEAD'].includes(request.method)
    ? undefined
    : await request.clone().arrayBuffer();
  return new Request(url, {
    method: request.method,
    headers,
    body,
    redirect: 'manual'
  });
}

async function proxyAccountApi(request, env, pathname) {
  if (!['GET', 'HEAD'].includes(request.method) && !validateSameOrigin(request)) {
    return jsonResponse(403, { ok: false, error: 'Origem do pedido inválida.' });
  }
  return authStub(env).fetch(await internalRequest(request, pathname));
}

async function authorize(request, env, permission, unsafe = false) {
  const url = new URL('https://auth.internal/authorize');
  url.searchParams.set('permission', permission);
  if (unsafe) url.searchParams.set('unsafe', '1');
  const headers = new Headers();
  const cookie = request.headers.get('Cookie');
  const csrf = request.headers.get('X-CSRF-Token');
  if (cookie) headers.set('Cookie', cookie);
  if (csrf) headers.set('X-CSRF-Token', csrf);
  headers.set('X-Client-IP', clientIp(request));
  return authStub(env).fetch(new Request(url, { headers }));
}

function securityHeaders(headers, contentType = '') {
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (contentType.includes('text/html')) {
    headers.set('Cache-Control', 'no-store');
    headers.set(
      'Content-Security-Policy',
      "default-src 'self'; " +
      "connect-src 'self' https://api.ipma.pt; " +
      "img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
      "script-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    );
  }
  return headers;
}

async function serveAsset(request, env) {
  const response = await env.ASSETS.fetch(request);
  const headers = securityHeaders(new Headers(response.headers), response.headers.get('Content-Type') || '');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function redirectTo(path, status = 302) {
  return new Response(null, {
    status,
    headers: { Location: path, 'Cache-Control': 'no-store' }
  });
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('O pedido EPE tem uma estrutura inválida.');
  }
  if (payload.versao !== 1 || payload.timezone !== 'Europe/Lisbon') {
    throw new Error('A versão ou o fuso horário do pedido não é suportado.');
  }
  if (!Array.isArray(payload.agendamentos) || payload.agendamentos.length > 4) {
    throw new Error('Só podem existir até quatro determinações EPE.');
  }
  payload.agendamentos.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Determinação ${index + 1}: estrutura inválida.`);
    }
    for (const field of ['nivel', 'tipo', 'inicio', 'fim']) {
      if (typeof entry[field] !== 'string' || !entry[field].trim()) {
        throw new Error(`Determinação ${index + 1}: campo ${field} em falta.`);
      }
    }
  });
}

function assetPermission(pathname) {
  let decodedPath = pathname;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    // Mantém o caminho original; o serviço de assets tratará o pedido inválido.
  }
  if (
    decodedPath === '/dashboard.html' ||
    decodedPath === '/tracadovct.png' ||
    /^\/IRI (Reduzido|Moderado|Elevado|Muito Elevado|Maximo)\//.test(decodedPath)
  ) {
    return 'access_dashboard';
  }
  if (decodedPath.startsWith('/lista-telefonica/')) return 'access_contacts';
  if (decodedPath.startsWith('/base-conhecimento/')) return 'access_knowledge';
  return 'access';
}

async function handleEpeSubmission(request, env, user) {
  if (!env.GITHUB_TOKEN) {
    return jsonResponse(503, { ok: false, error: 'O serviço EPE ainda não está configurado.' });
  }
  let payload;
  try {
    payload = await readJson(request, MAX_BODY_BYTES);
    validatePayload(payload);
  } catch (error) {
    return jsonResponse(400, { ok: false, error: error.message || 'Pedido EPE inválido.' });
  }

  const requestId = crypto.randomUUID();
  const dispatchPayload = {
    ...payload,
    request_id: requestId,
    recebido_em: new Date().toISOString(),
    operador: user.email
  };
  const owner = env.GITHUB_OWNER || DEFAULT_GITHUB_OWNER;
  const repo = env.GITHUB_REPO || DEFAULT_GITHUB_REPO;
  const workflow = env.GITHUB_WORKFLOW || DEFAULT_GITHUB_WORKFLOW;
  const ref = env.GITHUB_REF || DEFAULT_GITHUB_REF;
  const githubUrl = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;
  const githubResponse = await fetch(githubUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'dashboard-anepc-worker',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: JSON.stringify({
      ref,
      inputs: { epe_payload: JSON.stringify(dispatchPayload) }
    })
  });
  if (githubResponse.status !== 204) {
    console.error('GitHub workflow_dispatch recusado.', {
      status: githubResponse.status,
      detail: (await githubResponse.text()).slice(0, 500)
    });
    return jsonResponse(502, {
      ok: false,
      error: 'O GitHub recusou temporariamente a submissão. Tente novamente.'
    });
  }
  return jsonResponse(202, {
    ok: true,
    request_id: requestId,
    message: 'Pedido EPE recebido e enviado para validação.'
  });
}

async function handleEpeData(request, env) {
  const auth = await authorize(request, env, 'view_epe');
  if (auth.status !== 200) return auth;
  const owner = env.GITHUB_OWNER || DEFAULT_GITHUB_OWNER;
  const repo = env.GITHUB_REPO || DEFAULT_GITHUB_REPO;
  const ref = env.GITHUB_REF || DEFAULT_GITHUB_REF;
  const response = await fetch(
    `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/epe.csv?_=${Date.now()}`,
    { headers: { 'User-Agent': 'dashboard-anepc-worker' }, cf: { cacheTtl: 0 } }
  );
  if (!response.ok) {
    return jsonResponse(502, { ok: false, error: 'Não foi possível obter a agenda EPE.' });
  }
  return new Response(response.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return jsonResponse(200, { ok: true, service: 'dashboard-anepc' });
    }

    if (API_ROUTE_MAP.has(url.pathname)) {
      return proxyAccountApi(request, env, API_ROUTE_MAP.get(url.pathname));
    }
    const resetMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/reset-password$/);
    if (resetMatch) {
      return proxyAccountApi(request, env, `/users/${resetMatch[1]}/reset-password`);
    }
    const userMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (userMatch) return proxyAccountApi(request, env, `/users/${userMatch[1]}`);

    if (request.method === 'GET' && url.pathname === '/api/epe-data') {
      return handleEpeData(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/api/epe') {
      if (!validateSameOrigin(request)) {
        return jsonResponse(403, { ok: false, error: 'Origem do pedido inválida.' });
      }
      const auth = await authorize(request, env, 'manage_epe', true);
      if (auth.status !== 200) return auth;
      const identity = await auth.json();
      return handleEpeSubmission(request, env, identity.user);
    }

    if (PUBLIC_ASSETS.has(url.pathname)) {
      if (url.pathname === '/login.html') {
        const auth = await authorize(request, env, 'access');
        if (auth.status === 200) return redirectTo('/');
      }
      return serveAsset(request, env);
    }

    const auth = await authorize(request, env, assetPermission(url.pathname));
    if (auth.status === 401) {
      const next = encodeURIComponent(`${url.pathname}${url.search}`);
      return redirectTo(`/login.html?next=${next}`);
    }
    if (auth.status === 428) return redirectTo('/login.html?change=1');
    if (auth.status !== 200) return auth;
    return serveAsset(request, env);
  }
};
