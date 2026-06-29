import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { resizeForModel } from './widgetChatImage';

async function makePng(w: number, h: number): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .png().toBuffer();
}

describe('resizeForModel', () => {
  it('downscales the long edge to <=1024 and outputs jpeg', async () => {
    const src = await makePng(4000, 2000);
    const out = await resizeForModel(src, 'image/png');
    expect(out.mime).toBe('image/jpeg');
    expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(1024);
    expect(out.width / out.height).toBeCloseTo(2, 1);
    expect(out.buffer.length).toBeLessThan(src.length);
  });

  it('re-encodes small images without upscaling', async () => {
    const src = await makePng(300, 200);
    const out = await resizeForModel(src, 'image/png');
    expect(out.width).toBe(300);
    expect(out.height).toBe(200);
    expect(out.mime).toBe('image/jpeg');
  });
});
