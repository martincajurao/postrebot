/**
 * Resize the restaurant.png to 192x192 for PWA icon.
 * Uses a simple nearest-neighbor approach with PNG decoding/encoding.
 */
const fs = require('fs');
const zlib = require('zlib');

function readPNG(filePath) {
  const buf = fs.readFileSync(filePath);
  
  // Verify PNG signature
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== signature[i]) throw new Error('Not a valid PNG file');
  }
  
  let pos = 8;
  let width, height, bitDepth, colorType;
  const idatData = [];
  
  while (pos < buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + length);
    
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idatData.push(data);
    } else if (type === 'IEND') {
      break;
    }
    
    pos += 12 + length; // 4 (length) + 4 (type) + length + 4 (crc)
  }
  
  return { width, height, bitDepth, colorType, idatData: Buffer.concat(idatData) };
}

function decodePNG(width, height, bitDepth, colorType, idatData) {
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const bpp = channels * (bitDepth / 8);
  const stride = width * bpp;
  
  // Decompress
  const raw = zlib.inflateSync(idatData);
  
  // Remove filter bytes
  const pixels = Buffer.alloc(height * stride);
  let rawPos = 0;
  
  for (let y = 0; y < height; y++) {
    const filter = raw[rawPos++];
    const rowStart = y * stride;
    
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[rawPos++];
      const a = x >= bpp ? pixels[rowStart + x - bpp] : 0;
      const b = y > 0 ? pixels[rowStart - stride + x] : 0;
      const c = (x >= bpp && y > 0) ? pixels[rowStart - stride + x - bpp] : 0;
      
      let val;
      switch (filter) {
        case 0: val = rawByte; break;
        case 1: val = rawByte + a; break;
        case 2: val = rawByte + b; break;
        case 3: val = rawByte + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          val = rawByte + pr;
          break;
        }
        default: val = rawByte;
      }
      pixels[rowStart + x] = val & 0xFF;
    }
  }
  
  return { pixels, channels, bpp, stride };
}

function resizePNG(srcPixels, srcWidth, srcHeight, dstWidth, dstHeight, channels) {
  const dstPixels = Buffer.alloc(dstWidth * dstHeight * channels);
  const xRatio = srcWidth / dstWidth;
  const yRatio = srcHeight / dstHeight;
  
  for (let y = 0; y < dstHeight; y++) {
    for (let x = 0; x < dstWidth; x++) {
      const srcX = Math.floor(x * xRatio);
      const srcY = Math.floor(y * yRatio);
      const srcOffset = (srcY * srcWidth + srcX) * channels;
      const dstOffset = (y * dstWidth + x) * channels;
      
      for (let c = 0; c < channels; c++) {
        dstPixels[dstOffset + c] = srcPixels[srcOffset + c];
      }
    }
  }
  
  return dstPixels;
}

function encodePNG(width, height, channels, pixels) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  
  // IHDR
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = channels === 4 ? 6 : 2; // color type
  const ihdr = createChunk('IHDR', ihdrData);
  
  // Add filter bytes and compress
  const stride = width * channels;
  const rawData = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    rawData[y * (1 + stride)] = 0; // filter: none
    pixels.copy(rawData, y * (1 + stride) + 1, y * stride, (y + 1) * stride);
  }
  const compressed = zlib.deflateSync(rawData, { level: 9 });
  const idat = createChunk('IDAT', compressed);
  
  // IEND
  const iend = createChunk('IEND', Buffer.alloc(0));
  
  return Buffer.concat([signature, ihdr, idat, iend]);
}

function createChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crcData = Buffer.concat([typeBuffer, data]);
  const crc = crc32(crcData);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc >>> 0, 0);
  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

function crc32(data) {
  let crc = 0xFFFFFFFF;
  const table = getCrc32Table();
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

let crc32Table = null;
function getCrc32Table() {
  if (crc32Table) return crc32Table;
  crc32Table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crc32Table[i] = c >>> 0;
  }
  return crc32Table;
}

// Main
const inputPath = process.argv[2] || 'restaurant.png';
const outputPath = process.argv[3] || 'icon-192.png';
const targetSize = parseInt(process.argv[4] || '192');

console.log(`Reading ${inputPath}...`);
const png = readPNG(inputPath);
console.log(`Original size: ${png.width}x${png.height}, channels: ${png.colorType === 6 ? 4 : 3}`);

console.log(`Decoding...`);
const { pixels, channels } = decodePNG(png.width, png.height, png.bitDepth, png.colorType, png.idatData);

console.log(`Resizing to ${targetSize}x${targetSize}...`);
const resized = resizePNG(pixels, png.width, png.height, targetSize, targetSize, channels);

console.log(`Encoding...`);
const output = encodePNG(targetSize, targetSize, channels, resized);

fs.writeFileSync(outputPath, output);
console.log(`Saved to ${outputPath}`);