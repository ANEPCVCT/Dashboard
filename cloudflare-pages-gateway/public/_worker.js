export default {
  async fetch(request, env) {
    if (!env.PORTAL_WORKER || typeof env.PORTAL_WORKER.fetch !== 'function') {
      return Response.json(
        { ok: false, error: 'Ligação interna ao Portal indisponível.' },
        { status: 503 }
      );
    }

    return env.PORTAL_WORKER.fetch(request);
  }
};
