/**
 * Remy3D, Kiri Engine & Insta360 loader.
 *
 * Only the CORS-blocked share-page resolution uses the lightweight /resolve
 * Pages Function. Model binaries and cameras.json are downloaded directly
 * from their CDN by the browser.
 */

const RESOLVER_ENDPOINT = '/resolve';
const RESOLVER_TIMEOUT_MS = 20000;
const MODEL_IDLE_TIMEOUT_MS = 30000;

export async function extractPLYFromUrl(shareUrl, { forceRefresh = false } = {}) {
  const resolverQuery = new URLSearchParams({
    url: shareUrl,
    refresh: `${Date.now()}-${forceRefresh ? 'retry' : 'initial'}`
  });
  const resolverUrl = `${RESOLVER_ENDPOINT}?${resolverQuery.toString()}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RESOLVER_TIMEOUT_MS);
  let response;

  try {
    response = await fetch(resolverUrl, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Share link resolution timed out. Please check the network and try again.');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText);
    throw new Error(`Share link resolution failed (${response.status}): ${message}`);
  }

  const result = await response.json();
  if (!result.plyUrl && !result.splatUrl && !result.sogUrl) {
    throw new Error('No supported SOG, PLY, or Splat model was found in this share link.');
  }

  if (result.camerasUrl) {
    try {
      const camerasResponse = await fetch(result.camerasUrl);
      if (!camerasResponse.ok) throw new Error(`HTTP ${camerasResponse.status}`);
      const cameras = await camerasResponse.json();
      const firstCamera = cameras.find(camera => camera.id === 0) || cameras[0];
      if (firstCamera?.position) result.initialCameraPosition = firstCamera.position;
    } catch (error) {
      console.warn('Direct cameras.json download failed:', error.message);
    }
  }

  return result;
}

/**
 * Download a SOG/PLY/Splat file directly from the source CDN.
 */
export async function downloadPLY(url, onProgress) {
  const cleanUrl = url.replace(/\\u002F/g, '/');
  const pathname = new URL(cleanUrl).pathname.toLowerCase();
  const format = pathname.endsWith('.sog')
    ? 'SOG'
    : pathname.endsWith('.splat')
      ? 'Splat'
      : pathname.endsWith('.ply')
        ? 'PLY'
        : null;
  if (!format) throw new Error('Unsupported model format. Expected SOG, PLY, or Splat.');
  console.log(`Downloading ${format} directly from CDN`);
  const controller = new AbortController();
  let idleTimeoutId = null;
  const refreshIdleTimeout = () => {
    clearTimeout(idleTimeoutId);
    idleTimeoutId = setTimeout(() => controller.abort(), MODEL_IDLE_TIMEOUT_MS);
  };

  try {
    refreshIdleTimeout();
    const response = await fetch(cleanUrl, {
      cache: 'no-store',
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`Direct model download failed (${response.status}): ${response.statusText}`);
    }

    const contentLength = Number(response.headers.get('content-length')) || 0;
    if (!response.body) {
      const buffer = await response.arrayBuffer();
      onProgress?.(1);
      return buffer;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      refreshIdleTimeout();
      chunks.push(value);
      received += value.byteLength;
      if (contentLength > 0) onProgress?.(Math.min(received / contentLength, 1));
    }

    if (received < 100) {
      throw new Error('Downloaded model is too small to be valid.');
    }

    const combined = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }

    if (format === 'PLY') {
      const header = new TextDecoder().decode(combined.subarray(0, 3));
      if (header !== 'ply') throw new Error('Downloaded file is not a valid PLY file.');
    } else if (format === 'SOG') {
      if (combined[0] !== 0x50 || combined[1] !== 0x4b) {
        throw new Error('Downloaded file is not a valid SOG archive.');
      }
    }

    onProgress?.(1);
    return combined.buffer;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Model download stalled. Please check the network and try again.');
    }
    throw error;
  } finally {
    clearTimeout(idleTimeoutId);
  }
}
