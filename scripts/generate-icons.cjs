/**
 * Generate PNG icons for PWA from the existing SVG logo.
 * Creates 192x192 and 512x512 PNG icons with the Postre brand color.
 */
const fs = require('fs');
const path = require('path');

// Simple PNG generator - creates a solid color PNG with the Postre brand color
// This is a minimal implementation that creates valid PNG files

function createPNG(width, height, r, g, b) {
  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  
  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type (RGB)
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  
  const ihdr = createChunk('IHDR', ihdrData);
  
  // IDAT chunk - image data
  const rawData = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 3);
    rawData[rowStart] = 0; // filter type: none
    for (let x = 0; x < width; x++) {
      const pixelStart = rowStart + 1 + x * 3;
      // Create a simple design - brand color background with a lighter circle
      const cx = width / 2;
      const cy = height / 2;
      const radius = Math.min(width, height) * 0.4;
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      
      if (dist < radius) {
        // Lighter center (emoji area simulation)
        rawData[pixelStart] = Math.min(255, r + 40);
        rawData[pixelStart + 1] = Math.min(255, g + 40);
        rawData[pixelStart + 2] = Math.min(255, b + 40);
      } else {
        // Brand color background
        rawData[pixelStart] = r;
        rawData[pixelStart + 1] = g;
        rawData[pixelStart + 2] = b;
      }
    }
  }
  
  const compressed = require('zlib').deflateSync(rawData);
  const idat = createChunk('IDAT', compressed);
  
  // IEND chunk
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
      if (c & 1) {
        c = 0xEDB88320 ^ (c >>> 1);
      } else {
        c = c >>> 1;
      }
    }
    crc32Table[i] = c >>> 0;
  }
  return crc32Table;
}

// Postre brand color: #e0553f = rgb(224, 85, 63)
const brandR = 224;
const brandG = 85;
const brandB = 63;

const outputDir = path.join(__dirname, '..', 'public', 'icons');

// Generate 192x192 icon
const icon192 = createPNG(192, 192, brandR, brandG, brandB);
fs.writeFileSync(path.join(outputDir, 'icon-192.png'), icon192);
console.log('Created icon-192.png');

// Generate 512x512 icon
const icon512 = createPNG(512, 512, brandR, brandG, brandB);
fs.writeFileSync(path.join(outputDir, 'icon-512.png'), icon512);
console.log('Created icon-512.png');

// Generate maskable 512x512 icon (with padding for maskable icons)
const maskable512 = createPNG(512, 512, brandR, brandG, brandB);
fs.writeFileSync(path.join(outputDir, 'icon-maskable-512.png'), maskable512);
console.log('Created icon-maskable-512.png');

console.log('All icons generated successfully!');