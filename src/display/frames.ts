import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

export interface ScreenFrame {
  png: Buffer;
  width: number;
  height: number;
}
const MAX_PIXELS = 4096 * 2160;
export const MAX_PPM_BYTES = MAX_PIXELS * 3 + 4096;

/** P6 permits comments between header tokens; consume only the raster separator after maxval. */
export function ppmToPng(ppm: Buffer): ScreenFrame {
  if (ppm.length > MAX_PPM_BYTES) throw new Error('QEMU 屏幕图像过大');
  let offset = 0;
  const whitespace = (byte: number) => byte === 32 || (byte >= 9 && byte <= 13);
  const token = (): string => {
    for (;;) {
      while (offset < ppm.length && whitespace(ppm[offset])) offset++;
      if (ppm[offset] !== 35) break;
      while (offset < ppm.length && ppm[offset] !== 10 && ppm[offset] !== 13) offset++;
    }
    const start = offset;
    while (offset < ppm.length && !whitespace(ppm[offset]) && ppm[offset] !== 35) offset++;
    if (offset === start || offset - start > 64) throw new Error('无效的 QEMU PPM 头');
    return ppm.subarray(start, offset).toString('ascii');
  };
  if (token() !== 'P6') throw new Error('QEMU 未返回 P6 屏幕图像');
  const widthToken = token();
  const heightToken = token();
  const maximum = token();
  if (!/^[1-9]\d*$/.test(widthToken) || !/^[1-9]\d*$/.test(heightToken) || maximum !== '255')
    throw new Error('无效的 QEMU PPM 尺寸或颜色深度');
  const width = Number(widthToken);
  const height = Number(heightToken);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width > 4096 ||
    height > 4096 ||
    width * height > MAX_PIXELS
  )
    throw new Error('QEMU 屏幕尺寸过大');
  if (!whitespace(ppm[offset])) throw new Error('QEMU PPM 缺少像素分隔符');
  const separator = ppm[offset++];
  if (separator === 13 && ppm[offset] === 10) offset++;
  const stride = width * 3;
  if (ppm.length - offset !== stride * height) throw new Error('QEMU PPM 像素数据长度不符');
  const raw = Buffer.allocUnsafe((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    ppm.copy(raw, y * (stride + 1) + 1, offset + y * stride, offset + (y + 1) * stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const png = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
  return { png, width, height };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.allocUnsafe(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, 'ascii');
  data.copy(chunk, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < data.length + 8; i++) crc = CRC_TABLE[(crc ^ chunk[i]) & 255] ^ (crc >>> 8);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8);
  return chunk;
}

/** One compressed frame and its digest; raw screenshots are never retained. */
export class ScreenFrames {
  private digest?: string;
  private frame?: ScreenFrame;

  convert(ppm: Buffer): ScreenFrame {
    if (ppm.length > MAX_PPM_BYTES) throw new Error('QEMU 屏幕图像过大');
    const digest = createHash('sha256').update(ppm).digest('hex');
    if (this.frame && this.digest === digest) return this.frame;
    const frame = ppmToPng(ppm);
    this.frame = frame;
    this.digest = digest;
    return frame;
  }

  clear(): void {
    this.digest = undefined;
    this.frame = undefined;
  }
}
