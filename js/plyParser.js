/**
 * PLY Binary Parser
 * Supports standard PLY (uint8 colors) and Gaussian Splatting PLY (SH DC coefficients).
 * Extracts vertex positions (x, y, z) and colors.
 */
const SH_C0 = 0.28209479177387814;
const MAX_PARTICLES = 500000;
const TYPE_SIZES = {
  char: 1, uchar: 1, uint8: 1, int8: 1,
  short: 2, ushort: 2, uint16: 2, int16: 2,
  int: 4, uint: 4, int32: 4, uint32: 4,
  float: 4, float32: 4,
  double: 8, float64: 8,
};
/**
 * Parse a PLY file buffer and extract vertex positions and colors.
 * @param {ArrayBuffer} buffer - The raw PLY file data.
 * @param {function} [onProgress] - Optional progress callback (0-1).
 * @returns {{ positions: Float32Array, colors: Float32Array, count: number }}
 */
export function parsePLY(buffer, onProgress, options = {}) {
  const header = parseHeader(buffer);
  if (!header) {
    throw new Error('Invalid PLY file: could not parse header');
  }
  const { vertexCount, chunkCount, properties, headerLength, format } = header;
  let data;
  if (chunkCount > 0) {
    data = parseCompressedBinary(buffer, header, onProgress, options);
  } else if (format !== 'binary_little_endian') {
    // Try to handle ASCII format as fallback
    if (format === 'ascii') {
      data = parseASCII(buffer, header, onProgress, options);
    } else {
      throw new Error(`Unsupported PLY format: ${format}. Only binary_little_endian and ascii are supported.`);
    }
  } else {
    data = parseBinary(buffer, header, onProgress, options);
  }
  
  if (data && data.recommendedCropFactor === undefined) {
    data.recommendedCropFactor = options.cropFactor !== undefined ? options.cropFactor : 2.5;
  }
  return data;
}
/**
 * Parse the PLY header to extract metadata.
 */
function parseHeader(buffer) {
  const decoder = new TextDecoder('ascii');
  // Read first 16KB for header (3DGS PLY can have very long headers with many SH properties)
  const headerText = decoder.decode(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 16384)));
  const headerEnd = headerText.indexOf('end_header\n');
  if (headerEnd === -1) {
    const headerEndRN = headerText.indexOf('end_header\r\n');
    if (headerEndRN === -1) return null;
    return parseHeaderText(headerText.substring(0, headerEndRN), headerEndRN + 12);
  }
  return parseHeaderText(headerText.substring(0, headerEnd), headerEnd + 11);
}
function parseHeaderText(text, headerLength) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines[0] !== 'ply') return null;
  let format = '';
  let vertexCount = 0;
  let chunkCount = 0;
  const properties = [];
  let inVertexElement = false;
  let inChunkElement = false;
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'format') {
      format = parts[1];
    } else if (parts[0] === 'element') {
      if (parts[1] === 'vertex') {
        inVertexElement = true;
        inChunkElement = false;
        vertexCount = parseInt(parts[2], 10);
      } else if (parts[1] === 'chunk') {
        inChunkElement = true;
        inVertexElement = false;
        chunkCount = parseInt(parts[2], 10);
      } else {
        inVertexElement = false;
        inChunkElement = false;
      }
    } else if (parts[0] === 'property') {
      if (parts[1] === 'list') {
        // List properties (like face indices) - skip
        properties.push({
          element: inVertexElement ? 'vertex' : (inChunkElement ? 'chunk' : 'other'),
          name: parts[4] || parts[3],
          type: 'list',
          countType: parts[2],
          valueType: parts[3],
          size: 0,
        });
      } else {
        const type = parts[1];
        const name = parts[2];
        properties.push({
          element: inVertexElement ? 'vertex' : (inChunkElement ? 'chunk' : 'other'),
          name,
          type,
          size: TYPE_SIZES[type] || 4,
        });
      }
    }
  }
  // Calculate vertex and chunk strides
  let vertexStride = 0;
  let chunkStride = 0;
  for (const prop of properties) {
    if (prop.element === 'vertex') {
      if (prop.type !== 'list') {
        prop.offset = vertexStride;
        vertexStride += prop.size;
      }
    } else if (prop.element === 'chunk') {
      if (prop.type !== 'list') {
        prop.offset = chunkStride;
        chunkStride += prop.size;
      }
    }
  }
  return { format, vertexCount, chunkCount, properties, headerLength, stride: vertexStride, vertexStride, chunkStride };
}
/**
 * Parse binary PLY data.
 */
function parseBinary(buffer, header, onProgress, options = {}) {
  const {
    maxParticles = 500000,
    cropOutliers = true,
    cropFactor = 1.0,
    minOpacity = 0.10
  } = options;
  const { vertexCount, properties, headerLength, stride } = header;
  const dataView = new DataView(buffer, headerLength);
  // Find property indices (case-insensitive and map aliases)
  const propMap = {};
  for (const prop of properties) {
    const lowerName = prop.name.toLowerCase();
    propMap[lowerName] = prop;
  }
  // Resolve properties with fallback aliases
  const posX = propMap.x;
  const posY = propMap.y;
  const posZ = propMap.z;
  const colorR = propMap.red || propMap.r || propMap.diffuse_red;
  const colorG = propMap.green || propMap.g || propMap.diffuse_green;
  const colorB = propMap.blue || propMap.b || propMap.diffuse_blue;
  const hasRGB = colorR && colorG && colorB;
  const hasSH = propMap.f_dc_0 && propMap.f_dc_1 && propMap.f_dc_2;
  const hasOpacity = propMap.opacity || propMap.alpha || propMap.a;
  const hasScale = propMap.scale_0 && propMap.scale_1 && propMap.scale_2;
  const hasRotation = propMap.rot_0 && propMap.rot_1 && propMap.rot_2 && propMap.rot_3;
  // --- Check if we need to normalize colors (if values are in 0-255 range) ---
  let needsNormalization = false;
  if (hasRGB) {
    if (colorR.type === 'uchar' || colorR.type === 'uint8') {
      needsNormalization = true;
    } else {
      // Check first 100 vertices to see if any color value is > 1.01
      const checkCount = Math.min(100, vertexCount);
      for (let i = 0; i < checkCount; i++) {
        const byteOffset = i * stride;
        const r = readProperty(dataView, byteOffset, colorR);
        const g = readProperty(dataView, byteOffset, colorG);
        const b = readProperty(dataView, byteOffset, colorB);
        if (r > 1.01 || g > 1.01 || b > 1.01) {
          needsNormalization = true;
          break;
        }
      }
    }
  }
  // --- Fast pre-pass for Outlier Detection (to crop background noise) ---
  let meanX = 0, meanY = 0, meanZ = 0;
  let avgDist = 0;
  let recommendedCropFactor = 2.5;
  if (cropOutliers && posX && posY && posZ) {
    let sumX = 0, sumY = 0, sumZ = 0;
    let validCount = 0;
    // Sample up to 10,000 points to compute average center of mass
    const sampleStep = Math.max(1, Math.floor(vertexCount / 10000));
    for (let i = 0; i < vertexCount; i += sampleStep) {
      const byteOffset = i * stride;
      const x = readProperty(dataView, byteOffset, posX);
      const y = readProperty(dataView, byteOffset, posY);
      const z = readProperty(dataView, byteOffset, posZ);
      if (isFinite(x) && isFinite(y) && isFinite(z)) {
        sumX += x;
        sumY += y;
        sumZ += z;
        validCount++;
      }
    }
    if (validCount > 0) {
      meanX = sumX / validCount;
      meanY = sumY / validCount;
      meanZ = sumZ / validCount;
      const distances = [];
      for (let i = 0; i < vertexCount; i += sampleStep) {
        const byteOffset = i * stride;
        const x = readProperty(dataView, byteOffset, posX);
        const y = readProperty(dataView, byteOffset, posY);
        const z = readProperty(dataView, byteOffset, posZ);
        if (isFinite(x) && isFinite(y) && isFinite(z)) {
          distances.push(Math.sqrt((x - meanX)**2 + (y - meanY)**2 + (z - meanZ)**2));
        }
      }
      if (distances.length > 0) {
        distances.sort((a, b) => a - b);
        // Median distance represents a robust estimate of the main object radius
        const medianIdx = Math.floor(distances.length * 0.5);
        avgDist = distances[medianIdx];
        
        // Statistical standard deviation and tail density analysis
        let countFar = 0;
        let sumSqDiff = 0;
        const len = distances.length;
        for (let i = 0; i < len; i++) {
          const d = distances[i];
          sumSqDiff += (d - avgDist) ** 2;
          if (d > 1.8 * avgDist) countFar++;
        }
        const stdDev = Math.sqrt(sumSqDiff / len);
        const coefOfVariation = stdDev / avgDist;
        const farRatio = countFar / len;
        const maxDist = distances[len - 1];
        
        if (coefOfVariation > 0.8) {
          if (farRatio < 0.05) {
            recommendedCropFactor = 1.5;
          } else if (farRatio < 0.12) {
            recommendedCropFactor = 2.0;
          } else {
            recommendedCropFactor = 3.0; // Keep environment (Off)
          }
        } else {
          recommendedCropFactor = 2.5;
        }
        
        console.log(`[Auto-Crop Analysis] CV: ${coefOfVariation.toFixed(2)}, FarRatio: ${(farRatio*100).toFixed(1)}%, Max: ${(maxDist/avgDist).toFixed(1)}x, Recommended Crop: ${recommendedCropFactor}x`);
      }
    }
  }
  
  const finalCropFactor = options.autoCropFactor ? recommendedCropFactor : (options.cropFactor !== undefined ? options.cropFactor : 2.5);
  // Subsampling
  const step = Math.max(1, Math.floor(vertexCount / maxParticles));
  const sampledCount = Math.ceil(vertexCount / step);
  const positions = new Float32Array(sampledCount * 3);
  const colors = new Float32Array(sampledCount * 3);
  const scales = new Float32Array(sampledCount * 3);
  const rotations = new Float32Array(sampledCount * 4);
  const opacities = new Float32Array(sampledCount);
  let outputIdx = 0;
  for (let i = 0; i < vertexCount; i += step) {
    const byteOffset = i * stride;
    if (onProgress && i % 50000 === 0) {
      onProgress(i / vertexCount);
    }
    // Position
    const x = readProperty(dataView, byteOffset, posX);
    const y = readProperty(dataView, byteOffset, posY);
    const z = readProperty(dataView, byteOffset, posZ);
    // Filter out NaN or extremely large values
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
    if (Math.abs(x) > 100 || Math.abs(y) > 100 || Math.abs(z) > 100) continue;
    // Apply Outlier Cropping (distance filter)
    if (cropOutliers && avgDist > 0) {
      const dist = Math.sqrt((x - meanX)**2 + (y - meanY)**2 + (z - meanZ)**2);
      if (dist > avgDist * finalCropFactor) {
        continue;
      }
    }
    // Apply opacity if available (dim/skip low-opacity particles)
    let opacity = 1.0;
    if (hasOpacity) {
      const opacityProp = propMap.opacity || propMap.alpha || propMap.a;
      const rawOpacity = readProperty(dataView, byteOffset, opacityProp);
      // In 3DGS, opacity is stored as logit; convert with sigmoid
      opacity = 1.0 / (1.0 + Math.exp(-rawOpacity));
      if (opacity < minOpacity) {
        // Skip background floaters/low opacity splats
        continue;
      }
    }
    positions[outputIdx * 3] = x;
    positions[outputIdx * 3 + 1] = y;
    positions[outputIdx * 3 + 2] = z;
    // Opacity
    opacities[outputIdx] = opacity;
    // Scale (3DGS scale is log-scale in PLY, so we do Math.exp)
    if (hasScale) {
      scales[outputIdx * 3] = Math.exp(readProperty(dataView, byteOffset, propMap.scale_0));
      scales[outputIdx * 3 + 1] = Math.exp(readProperty(dataView, byteOffset, propMap.scale_1));
      scales[outputIdx * 3 + 2] = Math.exp(readProperty(dataView, byteOffset, propMap.scale_2));
    } else {
      scales[outputIdx * 3] = 0.01;
      scales[outputIdx * 3 + 1] = 0.01;
      scales[outputIdx * 3 + 2] = 0.01;
    }
    // Rotation (normalize quaternion)
    if (hasRotation) {
      let r0 = readProperty(dataView, byteOffset, propMap.rot_0);
      let r1 = readProperty(dataView, byteOffset, propMap.rot_1);
      let r2 = readProperty(dataView, byteOffset, propMap.rot_2);
      let r3 = readProperty(dataView, byteOffset, propMap.rot_3);
      const rlen = Math.sqrt(r0*r0 + r1*r1 + r2*r2 + r3*r3);
      if (rlen > 0) {
        r0 /= rlen; r1 /= rlen; r2 /= rlen; r3 /= rlen;
      }
      rotations[outputIdx * 4] = r0;     // w
      rotations[outputIdx * 4 + 1] = r1; // x
      rotations[outputIdx * 4 + 2] = r2; // y
      rotations[outputIdx * 4 + 3] = r3; // z
    } else {
      rotations[outputIdx * 4] = 1.0;
      rotations[outputIdx * 4 + 1] = 0.0;
      rotations[outputIdx * 4 + 2] = 0.0;
      rotations[outputIdx * 4 + 3] = 0.0;
    }
    // Color
    if (hasSH) {
      // Convert SH DC coefficients to RGB
      const f0 = readProperty(dataView, byteOffset, propMap.f_dc_0);
      const f1 = readProperty(dataView, byteOffset, propMap.f_dc_1);
      const f2 = readProperty(dataView, byteOffset, propMap.f_dc_2);
      colors[outputIdx * 3] = Math.max(0, Math.min(1, SH_C0 * f0 + 0.5));
      colors[outputIdx * 3 + 1] = Math.max(0, Math.min(1, SH_C0 * f1 + 0.5));
      colors[outputIdx * 3 + 2] = Math.max(0, Math.min(1, SH_C0 * f2 + 0.5));
    } else if (hasRGB) {
      const r = readProperty(dataView, byteOffset, colorR);
      const g = readProperty(dataView, byteOffset, colorG);
      const b = readProperty(dataView, byteOffset, colorB);
      if (needsNormalization) {
        colors[outputIdx * 3] = r / 255;
        colors[outputIdx * 3 + 1] = g / 255;
        colors[outputIdx * 3 + 2] = b / 255;
      } else {
        colors[outputIdx * 3] = Math.max(0, Math.min(1, r));
        colors[outputIdx * 3 + 1] = Math.max(0, Math.min(1, g));
        colors[outputIdx * 3 + 2] = Math.max(0, Math.min(1, b));
      }
    } else {
      // Default white-ish color
      colors[outputIdx * 3] = 0.85;
      colors[outputIdx * 3 + 1] = 0.9;
      colors[outputIdx * 3 + 2] = 1.0;
    }
    outputIdx++;
  }
  if (onProgress) onProgress(1);
  // Trim arrays to actual size
  const finalPositions = positions.slice(0, outputIdx * 3);
  const finalColors = colors.slice(0, outputIdx * 3);
  const finalScales = scales.slice(0, outputIdx * 3);
  const finalRotations = rotations.slice(0, outputIdx * 4);
  const finalOpacities = opacities.slice(0, outputIdx);
  return {
    positions: finalPositions,
    colors: finalColors,
    scales: finalScales,
    rotations: finalRotations,
    opacities: finalOpacities,
    count: outputIdx,
    recommendedCropFactor: finalCropFactor
  };
}
/**
 * Read a single property value from the DataView.
 */
function readProperty(dataView, baseOffset, prop) {
  const offset = baseOffset + prop.offset;
  switch (prop.type) {
    case 'float':
    case 'float32':
      return dataView.getFloat32(offset, true);
    case 'double':
    case 'float64':
      return dataView.getFloat64(offset, true);
    case 'uchar':
    case 'uint8':
      return dataView.getUint8(offset);
    case 'char':
    case 'int8':
      return dataView.getInt8(offset);
    case 'ushort':
    case 'uint16':
      return dataView.getUint16(offset, true);
    case 'short':
    case 'int16':
      return dataView.getInt16(offset, true);
    case 'uint':
    case 'uint32':
      return dataView.getUint32(offset, true);
    case 'int':
    case 'int32':
      return dataView.getInt32(offset, true);
    default:
      return dataView.getFloat32(offset, true);
  }
}
/**
 * Parse ASCII PLY data (fallback).
 */
function parseASCII(buffer, header, onProgress, options = {}) {
  const {
    maxParticles = 500000,
    cropOutliers = true,
    cropFactor = 1.0,
    minOpacity = 0.10
  } = options;
  const decoder = new TextDecoder('ascii');
  const text = decoder.decode(new Uint8Array(buffer, header.headerLength));
  const lines = text.trim().split(/\r?\n/);
  const { vertexCount, properties } = header;
  const propNames = properties.map(p => p.name.toLowerCase());
  const xIdx = propNames.indexOf('x');
  const yIdx = propNames.indexOf('y');
  const zIdx = propNames.indexOf('z');
  // Resolve color indices with aliases
  let rIdx = propNames.indexOf('red');
  if (rIdx === -1) rIdx = propNames.indexOf('r');
  if (rIdx === -1) rIdx = propNames.indexOf('diffuse_red');
  let gIdx = propNames.indexOf('green');
  if (gIdx === -1) gIdx = propNames.indexOf('g');
  if (gIdx === -1) gIdx = propNames.indexOf('diffuse_green');
  let bIdx = propNames.indexOf('blue');
  if (bIdx === -1) bIdx = propNames.indexOf('b');
  if (bIdx === -1) bIdx = propNames.indexOf('diffuse_blue');
  const hasRGB = rIdx !== -1 && gIdx !== -1 && bIdx !== -1;
  const hasSH = propNames.includes('f_dc_0') && propNames.includes('f_dc_1') && propNames.includes('f_dc_2');
  const f0Idx = propNames.indexOf('f_dc_0');
  const f1Idx = propNames.indexOf('f_dc_1');
  const f2Idx = propNames.indexOf('f_dc_2');
  let opacityIdx = propNames.indexOf('opacity');
  if (opacityIdx === -1) opacityIdx = propNames.indexOf('alpha');
  if (opacityIdx === -1) opacityIdx = propNames.indexOf('a');
  const hasOpacity = opacityIdx !== -1;
  // Check if we need to normalize colors
  let needsNormalization = false;
  if (hasRGB) {
    const isUchar = properties[rIdx].type === 'uchar' || properties[rIdx].type === 'uint8';
    if (isUchar) {
      needsNormalization = true;
    } else {
      // Check first 100 lines
      const checkCount = Math.min(100, lines.length);
      for (let i = 0; i < checkCount; i++) {
        const values = lines[i].trim().split(/\s+/).map(Number);
        if (values.length > Math.max(rIdx, gIdx, bIdx)) {
          const r = values[rIdx];
          const g = values[gIdx];
          const b = values[bIdx];
          if (r > 1.01 || g > 1.01 || b > 1.01) {
            needsNormalization = true;
            break;
          }
        }
      }
    }
  }
  // --- Fast pre-pass for Outlier Detection (ASCII) ---
  let meanX = 0, meanY = 0, meanZ = 0;
  let avgDist = 0;
  if (cropOutliers && xIdx !== -1 && yIdx !== -1 && zIdx !== -1) {
    let sumX = 0, sumY = 0, sumZ = 0;
    let validCount = 0;
    const sampleStep = Math.max(1, Math.floor(lines.length / 5000)); // Sample 5,000 for ASCII speed
    for (let i = 0; i < lines.length; i += sampleStep) {
      const values = lines[i].trim().split(/\s+/).map(Number);
      if (values.length > Math.max(xIdx, yIdx, zIdx)) {
        const x = values[xIdx], y = values[yIdx], z = values[zIdx];
        if (isFinite(x) && isFinite(y) && isFinite(z)) {
          sumX += x;
          sumY += y;
          sumZ += z;
          validCount++;
        }
      }
    }
    if (validCount > 0) {
      meanX = sumX / validCount;
      meanY = sumY / validCount;
      meanZ = sumZ / validCount;
      const distances = [];
      for (let i = 0; i < lines.length; i += sampleStep) {
        const values = lines[i].trim().split(/\s+/).map(Number);
        if (values.length > Math.max(xIdx, yIdx, zIdx)) {
          const x = values[xIdx], y = values[yIdx], z = values[zIdx];
          if (isFinite(x) && isFinite(y) && isFinite(z)) {
            distances.push(Math.sqrt((x - meanX)**2 + (y - meanY)**2 + (z - meanZ)**2));
          }
        }
      }
      if (distances.length > 0) {
        distances.sort((a, b) => a - b);
        const medianIdx = Math.floor(distances.length * 0.5);
        avgDist = distances[medianIdx];
      }
    }
  }
  const step = Math.max(1, Math.floor(vertexCount / maxParticles));
  const sampledCount = Math.ceil(vertexCount / step);
  const positions = new Float32Array(sampledCount * 3);
  const colors = new Float32Array(sampledCount * 3);
  let outputIdx = 0;
  for (let i = 0; i < Math.min(vertexCount, lines.length); i += step) {
    const values = lines[i].trim().split(/\s+/).map(Number);
    if (onProgress && i % 50000 === 0) onProgress(i / vertexCount);
    if (values.length <= Math.max(xIdx, yIdx, zIdx)) continue;
    const x = values[xIdx], y = values[yIdx], z = values[zIdx];
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
    // Apply Outlier Crop
    if (cropOutliers && avgDist > 0) {
      const dist = Math.sqrt((x - meanX)**2 + (y - meanY)**2 + (z - meanZ)**2);
      if (dist > avgDist * cropFactor) {
        continue;
      }
    }
    // Apply opacity filter
    let opacity = 1.0;
    if (hasOpacity && values.length > opacityIdx) {
      const rawOpacity = values[opacityIdx];
      // In 3DGS, opacity is stored as logit; convert with sigmoid
      opacity = 1.0 / (1.0 + Math.exp(-rawOpacity));
      if (opacity < minOpacity) {
        continue;
      }
    }
    positions[outputIdx * 3] = x;
    positions[outputIdx * 3 + 1] = y;
    positions[outputIdx * 3 + 2] = z;
    if (hasSH) {
      colors[outputIdx * 3] = Math.max(0, Math.min(1, SH_C0 * values[f0Idx] + 0.5));
      colors[outputIdx * 3 + 1] = Math.max(0, Math.min(1, SH_C0 * values[f1Idx] + 0.5));
      colors[outputIdx * 3 + 2] = Math.max(0, Math.min(1, SH_C0 * values[f2Idx] + 0.5));
    } else if (hasRGB) {
      const div = needsNormalization ? 255 : 1;
      colors[outputIdx * 3] = Math.max(0, Math.min(1, values[rIdx] / div));
      colors[outputIdx * 3 + 1] = Math.max(0, Math.min(1, values[gIdx] / div));
      colors[outputIdx * 3 + 2] = Math.max(0, Math.min(1, values[bIdx] / div));
    } else {
      colors[outputIdx * 3] = 0.85;
      colors[outputIdx * 3 + 1] = 0.9;
      colors[outputIdx * 3 + 2] = 1.0;
    }
    outputIdx++;
  }
  if (onProgress) onProgress(1);
  const defaultRotations = new Float32Array(outputIdx * 4);
  for (let i = 0; i < outputIdx; i++) {
    defaultRotations[i * 4] = 1.0; // W = 1
  }
  return {
    positions: positions.slice(0, outputIdx * 3),
    colors: colors.slice(0, outputIdx * 3),
    scales: new Float32Array(outputIdx * 3).fill(0.01),
    rotations: defaultRotations,
    opacities: new Float32Array(outputIdx).fill(1.0),
    count: outputIdx,
  };
}
/**
 * Parse PlayCanvas SuperSplat compressed binary PLY format.
 */
function parseCompressedBinary(buffer, header, onProgress, options = {}) {
  const {
    maxParticles = 500000,
    cropOutliers = true,
    cropFactor = 1.0,
  } = options;
  const { vertexCount, chunkCount, headerLength, vertexStride, chunkStride } = header;
  // Read Chunk Data
  const chunkDataBuffer = buffer.slice(headerLength, headerLength + chunkCount * chunkStride);
  const chunks = new Float32Array(chunkDataBuffer); // chunk properties are all floats
  // Read Vertex Data
  const vertexDataOffset = headerLength + chunkCount * chunkStride;
  const dataView = new DataView(buffer, vertexDataOffset);
  // Each vertex is 16 bytes = 4 uint32s: packed_position, packed_rotation, packed_scale, packed_color
  const step = Math.max(1, Math.floor(vertexCount / maxParticles));
  const sampledCount = Math.ceil(vertexCount / step);
  const positions = new Float32Array(sampledCount * 3);
  const colors = new Float32Array(sampledCount * 3);
  const scales = new Float32Array(sampledCount * 3);
  const rotations = new Float32Array(sampledCount * 4);
  const opacities = new Float32Array(sampledCount);
  // --- Fast pre-pass for Outlier Detection (Compressed) ---
  let meanX = 0, meanY = 0, meanZ = 0;
  let avgDist = 0;
  if (cropOutliers) {
    let sumX = 0, sumY = 0, sumZ = 0;
    let validCount = 0;
    const sampleStep = Math.max(1, Math.floor(vertexCount / 10000));
    for (let i = 0; i < vertexCount; i += sampleStep) {
      const byteOffset = i * 16;
      const packedPos = dataView.getUint32(byteOffset, true);
      
      const xRaw = (packedPos >> 21) & 0x7ff;
      const yRaw = (packedPos >> 11) & 0x3ff;
      const zRaw = packedPos & 0x7ff;
      const chunkIdx = Math.min(chunkCount - 1, Math.floor(i / 256));
      const chunkOffset = chunkIdx * 12; // 12 float properties per chunk
      const minX = chunks[chunkOffset + 0];
      const minY = chunks[chunkOffset + 1];
      const minZ = chunks[chunkOffset + 2];
      const maxX = chunks[chunkOffset + 3];
      const maxY = chunks[chunkOffset + 4];
      const maxZ = chunks[chunkOffset + 5];
      const x = minX + (xRaw / 2047) * (maxX - minX);
      const y = minY + (yRaw / 1023) * (maxY - minY);
      const z = minZ + (zRaw / 2047) * (maxZ - minZ);
      if (isFinite(x) && isFinite(y) && isFinite(z)) {
        sumX += x;
        sumY += y;
        sumZ += z;
        validCount++;
      }
    }
    if (validCount > 0) {
      meanX = sumX / validCount;
      meanY = sumY / validCount;
      meanZ = sumZ / validCount;
      const distances = [];
      for (let i = 0; i < vertexCount; i += sampleStep) {
        const byteOffset = i * 16;
        const packedPos = dataView.getUint32(byteOffset, true);
        
        const xRaw = (packedPos >> 21) & 0x7ff;
        const yRaw = (packedPos >> 11) & 0x3ff;
        const zRaw = packedPos & 0x7ff;
        const chunkIdx = Math.min(chunkCount - 1, Math.floor(i / 256));
        const chunkOffset = chunkIdx * 12;
        const minX = chunks[chunkOffset + 0];
        const minY = chunks[chunkOffset + 1];
        const minZ = chunks[chunkOffset + 2];
        const maxX = chunks[chunkOffset + 3];
        const maxY = chunks[chunkOffset + 4];
        const maxZ = chunks[chunkOffset + 5];
        const x = minX + (xRaw / 2047) * (maxX - minX);
        const y = minY + (yRaw / 1023) * (maxY - minY);
        const z = minZ + (zRaw / 2047) * (maxZ - minZ);
        if (isFinite(x) && isFinite(y) && isFinite(z)) {
          distances.push(Math.sqrt((x - meanX)**2 + (y - meanY)**2 + (z - meanZ)**2));
        }
      }
      if (distances.length > 0) {
        distances.sort((a, b) => a - b);
        const medianIdx = Math.floor(distances.length * 0.5);
        avgDist = distances[medianIdx];
      }
    }
  }
  let outputIdx = 0;
  for (let i = 0; i < vertexCount; i += step) {
    const byteOffset = i * 16;
    if (onProgress && i % 50000 === 0) {
      onProgress(i / vertexCount);
    }
    // Unpack Position (11-10-11 bits)
    const packedPos = dataView.getUint32(byteOffset, true);
    const xRaw = (packedPos >> 21) & 0x7ff;
    const yRaw = (packedPos >> 11) & 0x3ff;
    const zRaw = packedPos & 0x7ff;
    const chunkIdx = Math.min(chunkCount - 1, Math.floor(i / 256));
    const chunkOffset = chunkIdx * 12;
    const minX = chunks[chunkOffset + 0];
    const minY = chunks[chunkOffset + 1];
    const minZ = chunks[chunkOffset + 2];
    const maxX = chunks[chunkOffset + 3];
    const maxY = chunks[chunkOffset + 4];
    const maxZ = chunks[chunkOffset + 5];
    const x = minX + (xRaw / 2047) * (maxX - minX);
    const y = minY + (yRaw / 1023) * (maxY - minY);
    const z = minZ + (zRaw / 2047) * (maxZ - minZ);
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
    // Apply Outlier Crop
    if (cropOutliers && avgDist > 0) {
      const dist = Math.sqrt((x - meanX)**2 + (y - meanY)**2 + (z - meanZ)**2);
      if (dist > avgDist * cropFactor) {
        continue;
      }
    }
    positions[outputIdx * 3] = x;
    positions[outputIdx * 3 + 1] = y;
    positions[outputIdx * 3 + 2] = z;
    // Unpack Rotation (Smallest Three)
    const packedRot = dataView.getUint32(byteOffset + 4, true);
    const mode = (packedRot >> 30) & 3;
    const v1Raw = (packedRot >> 20) & 0x3ff;
    const v2Raw = (packedRot >> 10) & 0x3ff;
    const v3Raw = packedRot & 0x3ff;
    const v1 = (v1Raw / 1023) * 1.41421356 - 0.70710678;
    const v2 = (v2Raw / 1023) * 1.41421356 - 0.70710678;
    const v3 = (v3Raw / 1023) * 1.41421356 - 0.70710678;
    const sVal = 1.0 - (v1*v1 + v2*v2 + v3*v3);
    const v0 = Math.sqrt(Math.max(0.0, sVal));
    let qx = 0, qy = 0, qz = 0, qw = 1;
    if (mode === 0) {
      qx = v0; qy = v1; qz = v2; qw = v3;
    } else if (mode === 1) {
      qx = v1; qy = v0; qz = v2; qw = v3;
    } else if (mode === 2) {
      qx = v1; qy = v2; qz = v0; qw = v3;
    } else {
      qx = v1; qy = v2; qz = v3; qw = v0;
    }
    rotations[outputIdx * 4] = qw;
    rotations[outputIdx * 4 + 1] = qx;
    rotations[outputIdx * 4 + 2] = qy;
    rotations[outputIdx * 4 + 3] = qz;
    // Unpack Scale (11-10-11 bits)
    const packedScale = dataView.getUint32(byteOffset + 8, true);
    const sRawX = (packedScale >> 21) & 0x7ff;
    const sRawY = (packedScale >> 11) & 0x3ff;
    const sRawZ = packedScale & 0x7ff;
    const minScaleX = chunks[chunkOffset + 6];
    const minScaleY = chunks[chunkOffset + 7];
    const minScaleZ = chunks[chunkOffset + 8];
    const maxScaleX = chunks[chunkOffset + 9];
    const maxScaleY = chunks[chunkOffset + 10];
    const maxScaleZ = chunks[chunkOffset + 11];
    const logScaleX = minScaleX + (sRawX / 2047.0) * (maxScaleX - minScaleX);
    const logScaleY = minScaleY + (sRawY / 1023.0) * (maxScaleY - minScaleY);
    const logScaleZ = minScaleZ + (sRawZ / 2047.0) * (maxScaleZ - minScaleZ);
    scales[outputIdx * 3] = Math.exp(logScaleX);
    scales[outputIdx * 3 + 1] = Math.exp(logScaleY);
    scales[outputIdx * 3 + 2] = Math.exp(logScaleZ);
    // Unpack Color (RGBA 32-bit packed in big-endian bit order)
    const packedColor = dataView.getUint32(byteOffset + 12, true);
    
    // PlayCanvas color is packed such that Red is MSB, Alpha is LSB mathematically
    const r = ((packedColor >> 24) & 0xff) / 255;
    const g = ((packedColor >> 16) & 0xff) / 255;
    const b = ((packedColor >> 8) & 0xff) / 255;
    const a = (packedColor & 0xff) / 255;
    colors[outputIdx * 3] = r;
    colors[outputIdx * 3 + 1] = g;
    colors[outputIdx * 3 + 2] = b;
    opacities[outputIdx] = a;
    outputIdx++;
  }
  if (onProgress) onProgress(1);
  return {
    positions: positions.slice(0, outputIdx * 3),
    colors: colors.slice(0, outputIdx * 3),
    scales: scales.slice(0, outputIdx * 3),
    rotations: rotations.slice(0, outputIdx * 4),
    opacities: opacities.slice(0, outputIdx),
    count: outputIdx,
  };
}
/**
 * Crop a binary PLY buffer directly by keeping only non-outliers,
 * preserving all original properties (including f_rest_0 to f_rest_44) without artifacts.
 * @param {ArrayBuffer} buffer - The raw binary PLY buffer.
 * @param {object} options - Cropping options.
 * @returns {ArrayBuffer} Cropped binary PLY buffer.
 */
export function cropPLYBufferDirect(buffer, options = {}) {
  const header = parseHeader(buffer);
  if (!header) {
    throw new Error('Invalid PLY file: could not parse header');
  }
  const { vertexCount, chunkCount, properties, headerLength, stride, format } = header;
  
  // Fallback to original buffer if compressed or not binary
  if (chunkCount > 0 || format !== 'binary_little_endian') {
    return buffer;
  }
  
  const {
    maxParticles = 500000,
    cropOutliers = true,
    cropFactor = 1.0,
  } = options;
  
  const dataView = new DataView(buffer, headerLength);
  
  // Find property indices
  const propMap = {};
  for (const prop of properties) {
    propMap[prop.name.toLowerCase()] = prop;
  }
  const posX = propMap.x;
  const posY = propMap.y;
  const posZ = propMap.z;
  
  if (!posX || !posY || !posZ) {
    return buffer; // Cannot crop without positions
  }
  
  // Calculate average center of mass
  let meanX = 0, meanY = 0, meanZ = 0;
  let avgDist = 0;
  
  if (cropOutliers) {
    let sumX = 0, sumY = 0, sumZ = 0;
    let validCount = 0;
    const sampleStep = Math.max(1, Math.floor(vertexCount / 10000));
    for (let i = 0; i < vertexCount; i += sampleStep) {
      const byteOffset = i * stride;
      const x = readProperty(dataView, byteOffset, posX);
      const y = readProperty(dataView, byteOffset, posY);
      const z = readProperty(dataView, byteOffset, posZ);
      if (isFinite(x) && isFinite(y) && isFinite(z)) {
        sumX += x;
        sumY += y;
        sumZ += z;
        validCount++;
      }
    }
    if (validCount > 0) {
      meanX = sumX / validCount;
      meanY = sumY / validCount;
      meanZ = sumZ / validCount;
      const distances = [];
      for (let i = 0; i < vertexCount; i += sampleStep) {
        const byteOffset = i * stride;
        const x = readProperty(dataView, byteOffset, posX);
        const y = readProperty(dataView, byteOffset, posY);
        const z = readProperty(dataView, byteOffset, posZ);
        if (isFinite(x) && isFinite(y) && isFinite(z)) {
          distances.push(Math.sqrt((x - meanX)**2 + (y - meanY)**2 + (z - meanZ)**2));
        }
      }
      if (distances.length > 0) {
        distances.sort((a, b) => a - b);
        const medianIdx = Math.floor(distances.length * 0.5);
        avgDist = distances[medianIdx];
      }
    }
  }
  
  // Find kept indices
  const step = Math.max(1, Math.floor(vertexCount / maxParticles));
  const keptIndices = [];
  for (let i = 0; i < vertexCount; i += step) {
    const byteOffset = i * stride;
    const x = readProperty(dataView, byteOffset, posX);
    const y = readProperty(dataView, byteOffset, posY);
    const z = readProperty(dataView, byteOffset, posZ);
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
    if (Math.abs(x) > 100 || Math.abs(y) > 100 || Math.abs(z) > 100) continue;
    if (cropOutliers && avgDist > 0) {
      const dist = Math.sqrt((x - meanX)**2 + (y - meanY)**2 + (z - meanZ)**2);
      if (dist > avgDist * cropFactor) {
        continue;
      }
    }
    keptIndices.push(i);
  }
  
  // Reconstruct the new header text
  const originalHeaderBytes = new Uint8Array(buffer, 0, headerLength);
  const headerText = new TextDecoder('ascii').decode(originalHeaderBytes);
  const newHeaderText = headerText.replace(/element vertex \d+/, `element vertex ${keptIndices.length}`);
  const newHeaderBytes = new TextEncoder().encode(newHeaderText);
  
  // Create output buffer
  const outputLength = newHeaderBytes.byteLength + keptIndices.length * stride;
  const outputBuffer = new ArrayBuffer(outputLength);
  const outputUint8 = new Uint8Array(outputBuffer);
  
  // Write new header
  outputUint8.set(newHeaderBytes, 0);
  
  // Copy vertex data byte-for-byte
  const originalUint8 = new Uint8Array(buffer);
  const newHeaderLength = newHeaderBytes.byteLength;
  for (let k = 0; k < keptIndices.length; k++) {
    const originalIdx = keptIndices[k];
    const srcOffset = headerLength + originalIdx * stride;
    const dstOffset = newHeaderLength + k * stride;
    
    const vertexSlice = originalUint8.subarray(srcOffset, srcOffset + stride);
    outputUint8.set(vertexSlice, dstOffset);
  }
  
  return outputBuffer;
}
