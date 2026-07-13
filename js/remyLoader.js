/**
 * Remy3D & Kiri Engine loader.
 *
 * Only the CORS-blocked share-page resolution uses the lightweight /resolve
 * Pages Function. Model binaries and cameras.json are downloaded directly
 * from their CDN by the browser.
 */

const RESOLVER_ENDPOINT = '/resolve';

export async function extractPLYFromUrl(shareUrl) {
  const resolverUrl = `${RESOLVER_ENDPOINT}?url=${encodeURIComponent(shareUrl)}`;
  const response = await fetch(resolverUrl, {
    headers: { Accept: 'application/json' }
  });

  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText);
    throw new Error(`Share link resolution failed (${response.status}): ${message}`);
  }

  const result = await response.json();
  if (!result.plyUrl && !result.splatUrl) {
    throw new Error('No supported PLY or Splat model was found in this share link.');
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
 * Download a PLY/Splat file directly from the source CDN.
 */
export async function downloadPLY(url, onProgress) {
  const cleanUrl = url.replace(/\\u002F/g, '/');
  const isSplat = cleanUrl.toLowerCase().includes('.splat');
  console.log(`Downloading ${isSplat ? 'Splat' : 'PLY'} directly from CDN`);

  const response = await fetch(cleanUrl);
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

  if (!isSplat) {
    const header = new TextDecoder().decode(combined.subarray(0, 3));
    if (header !== 'ply') throw new Error('Downloaded file is not a valid PLY file.');
  }

  onProgress?.(1);
  return combined.buffer;
}
