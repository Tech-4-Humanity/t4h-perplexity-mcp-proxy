export const config = { runtime: 'edge' };

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
  return new Set(
    raw.split(',').map(s => s.trim()).filter(Boolean)
  );
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      ...extraHeaders,
    },
  });
}

function buildUpstreamHeaders(request) {
  const headers = new Headers(request.headers);
  const auth = process.env.MCP_UPSTREAM_AUTH || '';
  if (auth) headers.set('authorization', auth);
  headers.delete('host');
  return headers;
}

async function forwardRaw(request, upstreamUrl) {
  return fetch(upstreamUrl, {
    method: request.method,
    headers: buildUpstreamHeaders(request),
    body: request.method === 'GET' ? undefined : request.body,
    redirect: 'manual',
  });
}

async function handlePost(request, upstreamUrl) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    return forwardRaw(request, upstreamUrl);
  }

  const raw = await request.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return fetch(upstreamUrl, {
      method: 'POST',
      headers: buildUpstreamHeaders(request),
      body: raw,
      redirect: 'manual',
    });
  }

  const allowedTools = getAllowedTools();

  if (body?.method === 'tools/list') {
    const upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: buildUpstreamHeaders(request),
      body: raw,
      redirect: 'manual',
    });

    const text = await upstream.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return new Response(text, {
        status: upstream.status,
        headers: upstream.headers,
      });
    }

    if (parsed?.result?.tools && Array.isArray(parsed.result.tools)) {
      parsed.result.tools = parsed.result.tools.filter(
        tool => allowedTools.has(tool.name)
      );
    }

    return json(parsed, upstream.status);
  }

  if (body?.method === 'tools/call') {
    const toolName = body?.params?.name;
    if (toolName && !allowedTools.has(toolName)) {
      return json({
        jsonrpc: '2.0',
        id: body.id ?? null,
        error: {
          code: -32601,
          message: \`Tool not allowed: \${toolName}\`,
        },
      }, 403);
    }
  }

  return fetch(upstreamUrl, {
    method: 'POST',
    headers: buildUpstreamHeaders(request),
    body: raw,
    redirect: 'manual',
  });
}

export default async function handler(request) {
  const upstreamUrl = process.env.MCP_UPSTREAM_URL;
  if (!upstreamUrl) {
    return json({ ok: false, error: 'MCP_UPSTREAM_URL_NOT_SET' }, 500);
  }

  if (request.method === 'POST') {
    return handlePost(request, upstreamUrl);
  }

  if (request.method === 'GET' || request.method === 'DELETE') {
    return forwardRaw(request, upstreamUrl);
  }

  return new Response('Method Not Allowed', { status: 405 });
}
