import sharp from 'sharp';

/** Long-edge cap for the model-facing image. Vision tokens scale with pixel area;
 *  1024px keeps UI text legible at ~1k tokens / ~$0.005 per send on Opus 4.8. */
export const MODEL_IMAGE_MAX_EDGE = 1024;

export async function resizeForModel(
  buffer: Buffer,
  _mime: string,
): Promise<{ buffer: Buffer; mime: 'image/jpeg'; width: number; height: number }> {
  const out = await sharp(buffer)
    .rotate() // bake in EXIF orientation, then strip metadata (default)
    .resize({
      width: MODEL_IMAGE_MAX_EDGE,
      height: MODEL_IMAGE_MAX_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 80 })
    .toBuffer({ resolveWithObject: true });
  return { buffer: out.data, mime: 'image/jpeg', width: out.info.width, height: out.info.height };
}
