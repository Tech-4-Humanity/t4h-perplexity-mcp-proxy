/**
 * POST /api/mcp/session
 * Creates a new MCP session and returns the session ID.
 * Clients should call this first, then pass x-session-id on all subsequent requests.
 *
 * curl -X POST -H "Authorization: Bearer TOKEN" \
 *   https://t4h-perplexity-mcp-proxy.vercel.app/api/session
 */
export const config = { runtime: 'edge' };

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-expose-headers': 'x-session-id',
      },
    });
  }

  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  // Auth
  const token = process.env.MCP_BEARER_TOKEN;
  if (token) {
    const auth = request.headers.get('authorization') || '';
    if (auth !== `Bearer ${token}`) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Unauthorized' }),
        { status: 401, headers: { 'content-type': 'application/json' } }
      );
    }
  }

  const sessionId = crypto.randomUUID();

  return new Response(
    JSON.stringify({ ok: true, session_id: sessionId }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-session-id': sessionId,
        'access-control-allow-origin': '*',
        'access-control-expose-headers': 'x-session-id',
      },
    }
  );
}
