const path = require('path');
const zlib = require('zlib');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { analyzeSnapshot, getVisionLLMConfig } = require('../services/visionLLMService');

const makeCrcTable = () => {
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
};

const CRC_TABLE = makeCrcTable();

const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const pngChunk = (type, data = Buffer.alloc(0)) => {
  const typeBuffer = Buffer.from(type);
  const lengthBuffer = Buffer.alloc(4);
  const crcBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(data.length, 0);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer]);
};

const createMockSnapshotBase64 = () => {
  const width = 160;
  const height = 120;
  const bytesPerPixel = 4;
  const raw = Buffer.alloc((width * bytesPerPixel + 1) * height);

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * bytesPerPixel + 1);
    raw[rowStart] = 0;

    for (let x = 0; x < width; x += 1) {
      const offset = rowStart + 1 + x * bytesPerPixel;
      let r = 218;
      let g = 224;
      let b = 230;

      const dx = x - 80;
      const dy = y - 52;
      const inFaceOval = (dx * dx) / (34 * 34) + (dy * dy) / (38 * 38) <= 1;
      const inBody = y > 86 && Math.abs(x - 80) < 46;

      if (inFaceOval) {
        r = 191;
        g = 156;
        b = 128;
      } else if (inBody) {
        r = 55;
        g = 89;
        b = 138;
      }

      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = 255;
    }
  }

  const signature = Buffer.from('89504e470d0a1a0a', 'hex');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const png = Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND'),
  ]);

  return `data:image/png;base64,${png.toString('base64')}`;
};

async function main() {
  const config = getVisionLLMConfig();

  console.log('Vision LLM provider:', config.provider);
  console.log('Vision LLM model:', config.model);
  console.log('Vision LLM API key loaded:', config.apiKeyLoaded ? 'yes' : 'no');

  if (config.provider !== 'gemini') {
    console.log('Skipping live Gemini test because VISION_LLM_PROVIDER is not gemini.');
    return;
  }

  const result = await analyzeSnapshot(createMockSnapshotBase64());
  console.log(JSON.stringify(result, null, 2));

  if (result.skipped) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('Gemini vision test failed:', error.message);
  process.exitCode = 1;
});
