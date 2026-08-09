const MAX_BODY_BYTES = 16 * 1024;
const DEFAULT_ALLOWED_ORIGIN = 'https://anepcvct.github.io';
const DEFAULT_GITHUB_OWNER = 'ANEPCVCT';
const DEFAULT_GITHUB_REPO = 'Dashboard';
const DEFAULT_GITHUB_WORKFLOW = 'atualizar-epe.yml';
const DEFAULT_GITHUB_REF = 'main';

function jsonResponse(status, body, origin) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  };

  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }

  return new Response(JSON.stringify(body), { status, headers });
}

function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  const expected = env.ALLOWED_ORIGIN || DEFAULT_ALLOWED_ORIGIN;
  return origin === expected ? origin : null;
}

async function secureEqual(left, right) {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(String(left || ''))),
    crypto.subtle.digest('SHA-256', encoder.encode(String(right || '')))
  ]);
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let difference = a.length ^ b.length;

  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    difference |= (a[index] || 0) ^ (b[index] || 0);
  }

  return difference === 0;
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

function authorizationToken(request) {
  const value = request.headers.get('Authorization') || '';
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

async function handleSubmission(request, env, origin) {
  if (!env.EPE_OPERATOR_KEY || !env.GITHUB_TOKEN) {
    console.error('Segredos obrigatórios do Worker não configurados.');
    return jsonResponse(503, {
      ok: false,
      error: 'O serviço de submissão ainda não está configurado.'
    }, origin);
  }

  const suppliedKey = authorizationToken(request);
  if (!suppliedKey || !(await secureEqual(suppliedKey, env.EPE_OPERATOR_KEY))) {
    return jsonResponse(401, {
      ok: false,
      error: 'Chave de operador inválida.'
    }, origin);
  }

  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return jsonResponse(413, {
      ok: false,
      error: 'O pedido excede o tamanho permitido.'
    }, origin);
  }

  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    return jsonResponse(413, {
      ok: false,
      error: 'O pedido excede o tamanho permitido.'
    }, origin);
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
    validatePayload(payload);
  } catch (error) {
    return jsonResponse(400, {
      ok: false,
      error: error instanceof Error ? error.message : 'Pedido EPE inválido.'
    }, origin);
  }

  const requestId = crypto.randomUUID();
  const dispatchPayload = {
    ...payload,
    request_id: requestId,
    recebido_em: new Date().toISOString()
  };
  const owner = env.GITHUB_OWNER || DEFAULT_GITHUB_OWNER;
  const repo = env.GITHUB_REPO || DEFAULT_GITHUB_REPO;
  const workflow = env.GITHUB_WORKFLOW || DEFAULT_GITHUB_WORKFLOW;
  const ref = env.GITHUB_REF || DEFAULT_GITHUB_REF;
  const githubUrl = (
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/` +
    `${encodeURIComponent(workflow)}/dispatches`
  );
  const githubResponse = await fetch(githubUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'dashboard-anepc-epe-worker',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: JSON.stringify({
      ref,
      inputs: {
        epe_payload: JSON.stringify(dispatchPayload)
      }
    })
  });

  if (githubResponse.status !== 204) {
    const detail = (await githubResponse.text()).slice(0, 500);
    console.error('GitHub workflow_dispatch recusado.', {
      status: githubResponse.status,
      detail
    });
    return jsonResponse(502, {
      ok: false,
      error: 'O GitHub recusou temporariamente a submissão. Tente novamente.'
    }, origin);
  }

  return jsonResponse(202, {
    ok: true,
    request_id: requestId,
    message: 'Pedido EPE recebido e enviado para validação.'
  }, origin);
}

export default {
  async fetch(request, env) {
    const origin = allowedOrigin(request, env);
    const url = new URL(request.url);

    if (!origin) {
      return jsonResponse(403, {
        ok: false,
        error: 'Origem não autorizada.'
      });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Max-Age': '86400',
          Vary: 'Origin'
        }
      });
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return jsonResponse(200, {
        ok: true,
        service: 'dashboard-anepc-epe'
      }, origin);
    }

    if (request.method !== 'POST' || url.pathname !== '/epe') {
      return jsonResponse(404, {
        ok: false,
        error: 'Endpoint não encontrado.'
      }, origin);
    }

    return handleSubmission(request, env, origin);
  }
};
