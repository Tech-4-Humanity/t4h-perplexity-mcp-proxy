export const config = { runtime: 'edge' };

// ---------------------------------------------------------------------------
// In-memory session store (edge runtime — per-isolate, not cross-request
// persistent, but sufficient for single-session / short-lived MCP use).
// For production multi-instance use, swap this for KV / Supabase.
// ---------------------------------------------------------------------------
const sessions = new Map();

function getSessionId(request) {
  return (
    request.headers.get('x-session-id') ||
    request.headers.get('mcp-session-id') ||
    request.headers.get('session-id') ||
    new URL(request.url).searchParams.get('session_id') ||
    null
  );
}

function createSession(id) {
  sessions.set(id, { createdAt: Date.now(), initialized: false });
  return id;
}

function requireAuth(request) {
  const token = process.env.MCP_BEARER_TOKEN;
  if (!token) return null; // no token configured → open (dev mode)
  const auth = request.headers.get('authorization') || '';
  if (auth === `Bearer ${token}`) return null;
  return new Response(
    JSON.stringify({ ok: false, error: 'Unauthorized' }),
    { status: 401, headers: { 'content-type': 'application/json' } }
  );
}

const DEFAULT_ALLOWED_TOOLS = [
  'health_check',
  'supabase_schema_read',
  'supabase_sql_read',
  'github_repo_inspect',
  'github_file_read',
  'gdrive_search',
  'gdrive_file_read',
  'vercel_project_inspect',
  'vercel_deployments_list',
  'aws_lambda_inspect',
  'aws_lambda_logs_read',
  'aws_s3_list',
];

function getAllowedTools() {
  const raw = process.env.MCP_ALLOWED_TOOLS || DEFAULT_ALLOWED_TOOLS.join(',');
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

function buildUpstreamHeaders(request, sessionId) {
  const headers = new Headers(request.headers);
  const auth = process.env.MCP_UPSTREAM_AUTH || '';
  if (auth) headers.set('authorization', auth);
  if (sessionId) headers.set('x-session-id', sessionId);
  headers.delete('host');
  return headers;
}

async function forwardRaw(request, upstreamUrl, sessionId) {
  return fetch(upstreamUrl, {
    method: request.method,
    headers: buildUpstreamHeaders(request, sessionId),
    body: request.method === 'GET' ? undefined : request.body,
    redirect: 'manual',
  });
}

async function handlePost(request, upstreamUrl) {
  // ── Auth check ──────────────────────────────────────────────────────────
  const authErr = requireAuth(request);
  if (authErr) return authErr;

  // ── Session resolution ───────────────────────────────────────────────────
  let sessionId = getSessionId(request);
  let isNewSession = false;

  if (!sessionId) {
    // Auto-bootstrap: create a new session and tell the caller about it
    sessionId = crypto.randomUUID();
    createSession(sessionId);
    isNewSession = true;
  } else if (!sessions.has(sessionId)) {
    createSession(sessionId);
  }

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const resp = await forwardRaw(request, upstreamUrl, sessionId);
    // Always echo the session id back
    const h = new Headers(resp.headers);
    h.set('x-session-id', sessionId);
    return new Response(resp.body, { status: resp.status, headers: h });
  }

  const raw = await request.text();
  let body;
  try { body = JSON.parse(raw); }
  catch {
    const resp = await fetch(upstreamUrl, {
      method: 'POST',
      headers: buildUpstreamHeaders(request, sessionId),
      body: raw,
      redirect: 'manual',
    });
    const h = new Headers(resp.headers);
    h.set('x-session-id', sessionId);
    return new Response(resp.body, { status: resp.status, headers: h });
  }

  // ── If this is the initialize call, mark session ─────────────────────────
  if (body?.method === 'initialize') {
    const sess = sessions.get(sessionId) || {};
    sess.initialized = true;
    sessions.set(sessionId, sess);
  }

  const allowedTools = getAllowedTools();

  // ── tools/list — filter to allowed set ───────────────────────────────────
  if (body?.method === 'tools/list') {
    const upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: buildUpstreamHeaders(request, sessionId),
      body: raw,
      redirect: 'manual',
    });
    const text = await upstream.text();
    let parsed;
    try { parsed = JSON.parse(text); }
    catch {
      const h = new Headers(upstream.headers);
      h.set('x-session-id', sessionId);
      return new Response(text, { status: upstream.status, headers: h });
    }
    if (parsed?.result?.tools && Array.isArray(parsed.result.tools)) {
      parsed.result.tools = parsed.result.tools.filter(
        tool => allowedTools.has(tool.name)
      );
    }
    return json(parsed, upstream.status, { 'x-session-id': sessionId });
  }

  // ── tools/call — enforce allowlist ───────────────────────────────────────
  if (body?.method === 'tools/call') {
    const toolName = body?.params?.name;
    if (toolName && !allowedTools.has(toolName)) {
      return json({
        jsonrpc: '2.0',
        id: body.id ?? null,
        error: { code: -32601, message: 'Tool not allowed: ' + toolName },
      }, 403, { 'x-session-id': sessionId });
    }
  }

  // ── Default: forward to upstream ─────────────────────────────────────────
  const upstream = await fetch(upstreamUrl, {
    method: 'POST',
    headers: buildUpstreamHeaders(request, sessionId),
    body: raw,
    redirect: 'manual',
  });
  const h = new Headers(upstream.headers);
  h.set('x-session-id', sessionId);
  if (isNewSession) h.set('x-session-created', '1');
  return new Response(upstream.body, { status: upstream.status, headers: h });
}

export default async function handler(request) {
  const upstreamUrl = process.env.MCP_UPSTREAM_URL;
  if (!upstreamUrl) {
    return json({ ok: false, error: 'MCP_UPSTREAM_URL_NOT_SET' }, 500);
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
        'access-control-allow-headers':
          'authorization, content-type, x-session-id, mcp-session-id, session-id, accept',
        'access-control-expose-headers': 'x-session-id, x-session-created',
      },
    });
  }

  if (request.method === 'POST') return handlePost(request, upstreamUrl);
  if (request.method === 'GET' || request.method === 'DELETE') {
    const authErr = requireAuth(request);
    if (authErr) return authErr;
    const sessionId = getSessionId(request) || crypto.randomUUID();
    if (!sessions.has(sessionId)) createSession(sessionId);
    return forwardRaw(request, upstreamUrl, sessionId);
  }

  return new Response('Method Not Allowed', { status: 405 });
}
