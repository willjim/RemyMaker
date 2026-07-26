/**
 * Cloudflare Pages Function: resolve a Remy3D/Kiri share page into signed
 * asset URLs. Model files are never proxied through this function.
 */

const ALLOWED_SHARE_HOSTS = new Set([
  'www.remy3d.cn',
  'remy3d.cn',
  'www.kiriengine.app',
  'kiriengine.app',
  'www.kiriengine.com',
  'kiriengine.com'
]);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept, Content-Type',
  'Cache-Control': 'no-store'
};

export async function onRequestGet({ request }) {
  const requestUrl = new URL(request.url);
  const shareUrlValue = requestUrl.searchParams.get('url');
  if (!shareUrlValue) return textResponse('Missing url parameter', 400);

  let shareUrl;
  try {
    shareUrl = new URL(shareUrlValue);
  } catch {
    return textResponse('Invalid share URL', 400);
  }

  if (shareUrl.protocol !== 'https:' || !ALLOWED_SHARE_HOSTS.has(shareUrl.hostname)) {
    return textResponse('Share host is not allowed', 403);
  }

  const isKiri = shareUrl.hostname.includes('kiri');
  const validPath = isKiri
    ? shareUrl.pathname.startsWith('/share/')
    : shareUrl.pathname.startsWith('/model/') || shareUrl.pathname.startsWith('/share/');
  if (!validPath) return textResponse('Unsupported share URL path', 403);

  try {
    const referer = isKiri
      ? 'https://www.kiriengine.app/'
      : 'https://www.remy3d.cn/';
    const upstreamUrl = new URL(shareUrl);
    upstreamUrl.searchParams.set('_remymaker_refresh', Date.now().toString());
    const upstream = await fetch(upstreamUrl.toString(), {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Cache-Control': 'no-cache, no-store, max-age=0',
        Pragma: 'no-cache',
        Referer: referer,
        'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36 Chrome/120 Safari/537.36'
      },
      redirect: 'follow'
    });

    if (!upstream.ok) {
      return textResponse(`Share page returned HTTP ${upstream.status}`, 502);
    }

    const html = await upstream.text();
    const result = parseSharePage(html, isKiri);
    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' }
    });
  } catch (error) {
    return textResponse(`Unable to resolve share page: ${error.message}`, 502);
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

function parseSharePage(html, isKiri) {
  const match = html.match(/id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('Page does not contain Nuxt model data');

  const data = JSON.parse(match[1]);
  let plyUrl = null;
  let pcdUrl = null;
  let splatUrl = null;
  let camerasUrl = null;
  let unsupportedMeshUrl = null;

  for (const value of data) {
    if (typeof value !== 'string') continue;
    const normalized = value.replace(/\\u002F/g, '/');
    if (!normalized.startsWith('https://')) continue;
    if (normalized.includes('.splat')) splatUrl = normalized;
    if (normalized.includes('cameras.json')) camerasUrl = normalized;
    if (normalized.includes('.glb')) unsupportedMeshUrl = normalized;
    if (normalized.includes('.ply')) {
      if (normalized.includes('pcd.ply') || normalized.includes('/input/')) pcdUrl = normalized;
      else if (!plyUrl || normalized.includes('3DGS.ply') || normalized.includes('/output/')) plyUrl = normalized;
    }
  }

  if (!splatUrl && !plyUrl) {
    if (isKiri && unsupportedMeshUrl) throw new Error('This Kiri share is a Mesh model, not 3DGS');
    throw new Error('No supported Splat or PLY asset found');
  }

  return {
    name: findModelName(data, isKiri ? 'Kiri Model' : 'Remy Model'),
    splatUrl,
    plyUrl,
    pcdUrl,
    camerasUrl
  };
}

function findModelName(data, fallback) {
  for (let index = 0; index < data.length; index += 1) {
    if (data[index] !== 'name') continue;
    for (let offset = 1; offset <= 4; offset += 1) {
      const candidate = data[index + offset];
      if (typeof candidate === 'string' && candidate.length < 100 && !candidate.includes('http')) {
        return candidate;
      }
    }
  }
  return fallback;
}

function textResponse(message, status) {
  return new Response(message, {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' }
  });
}
