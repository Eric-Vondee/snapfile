import sharp from 'sharp'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import type { ImageKind } from '#services/file_kinds'
import {
  CompressionRejectedError,
  INPUT_FILE,
  type CompressionMode,
  type CompressionResult,
  type LossyMode,
} from '#services/compression'

/**
 * Longest side in pixels and encoder quality for each lossy mode. The
 * images inside Word and PowerPoint files use the same settings.
 */
export const IMAGE_SETTINGS: Record<LossyMode, { maxSide: number; quality: number }> = {
  balanced: { maxSide: 2048, quality: 80 },
  medium: { maxSide: 1600, quality: 70 },
  strong: { maxSide: 1280, quality: 55 },
}

/**
 * Re-encodes an image in its own format. Returns null when the mode
 * cannot touch it: Lossless only applies to 8-bit PNGs, since sharp
 * writes 8-bit output and every other format here is lossy.
 *
 * The output never carries EXIF, so `autoOrient` must be set when the
 * orientation tag should still apply: it rotates the pixels instead.
 */
export async function encodeImage(
  input: Uint8Array,
  kind: ImageKind,
  mode: CompressionMode,
  { autoOrient }: { autoOrient: boolean }
) {
  // Animated WebP keeps every frame; resizing applies to each one
  let image = sharp(input, { animated: kind === 'webp' }).keepIccProfile()
  if (autoOrient) image = image.autoOrient()

  if (mode === 'lossless') {
    if (kind !== 'png') return null
    const { depth } = await sharp(input).metadata()
    if (depth !== 'uchar') return null
    return image.png({ compressionLevel: 9, adaptiveFiltering: true, palette: false }).toBuffer()
  }

  const { maxSide, quality } = IMAGE_SETTINGS[mode]
  image = image.resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
  switch (kind) {
    case 'jpeg':
      return image.jpeg({ quality, mozjpeg: true }).toBuffer()
    case 'png':
      // Reduces to a palette of at most 256 colours, keeping transparency
      return image.png({ palette: true, quality, compressionLevel: 9 }).toBuffer()
    case 'webp':
      return image.webp({ quality, effort: 6 }).toBuffer()
  }
}

/**
 * Compresses the uploaded image into the same format, applying its EXIF
 * orientation and dropping metadata such as camera details and location.
 */
export async function compressImage(
  workDir: string,
  kind: ImageKind,
  mode: CompressionMode
): Promise<CompressionResult> {
  if (mode === 'lossless' && kind !== 'png') {
    throw new CompressionRejectedError(
      'Lossless mode only works for PNG images. Choose Balanced for JPG and WebP.'
    )
  }

  const inputPath = join(workDir, INPUT_FILE)
  const input = await readFile(inputPath)
  const original = await readDimensions(input).catch(() => {
    throw damagedImage()
  })

  let candidate: Buffer | null
  try {
    candidate = await encodeImage(input, kind, mode, { autoOrient: true })
  } catch {
    throw damagedImage()
  }

  if (!candidate || candidate.length >= input.length) {
    return {
      outputPath: inputPath,
      originalSize: input.length,
      outputSize: input.length,
      reduced: false,
      ...original,
    }
  }

  const outputPath = join(workDir, 'output')
  await writeFile(outputPath, candidate)
  return {
    outputPath,
    originalSize: input.length,
    outputSize: candidate.length,
    reduced: true,
    ...(await readDimensions(candidate)),
  }
}

/**
 * Size as displayed: after EXIF orientation, and per frame when animated.
 */
async function readDimensions(bytes: Uint8Array) {
  const metadata = await sharp(bytes, { animated: true }).metadata()
  const animated = (metadata.pages ?? 1) > 1
  return {
    width: metadata.autoOrient.width,
    height: animated ? (metadata.pageHeight ?? metadata.height) : metadata.autoOrient.height,
  }
}

function damagedImage() {
  return new CompressionRejectedError('This image is damaged and cannot be read.')
}
