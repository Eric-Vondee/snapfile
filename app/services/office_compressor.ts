import sharp from 'sharp'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { unzipSync, zipSync, type Unzipped, type Zippable } from 'fflate'
import { encodeImage } from '#services/image_compressor'
import { imageKind, type ImageKind, type OfficeKind } from '#services/file_kinds'
import {
  CompressionRejectedError,
  INPUT_FILE,
  type CompressionMode,
  type CompressionResult,
} from '#services/compression'

/**
 * Upper bounds on what a document may unpack to, so a small ZIP cannot
 * expand into gigabytes of memory. fflate never inflates an entry past
 * its declared size, so summing declared sizes is a real limit.
 */
const MAX_UNPACKED_BYTES = 250 * 1024 * 1024
const MAX_ENTRIES = 10_000

/**
 * Images below this size are copied as they are; re-encoding them saves
 * next to nothing.
 */
const MIN_IMAGE_BYTES = 16 * 1024

const MEDIA_FOLDER: Record<OfficeKind, string> = {
  docx: 'word/media/',
  pptx: 'ppt/media/',
}

const SLIDE = /^ppt\/slides\/slide\d+\.xml$/

/**
 * Compresses the images inside a Word or PowerPoint file and repacks it
 * with maximum ZIP compression. Every other part, including all text
 * and layout XML, is copied byte for byte. Images keep their format and
 * aspect ratio, and Office sizes them from the XML, so the layout does
 * not move.
 */
export async function compressOffice(
  workDir: string,
  kind: OfficeKind,
  mode: CompressionMode
): Promise<CompressionResult> {
  const inputPath = join(workDir, INPUT_FILE)
  const input = await readFile(inputPath)
  const entries = unpack(input)
  const names = Object.keys(entries)

  const files: Zippable = {}
  let imagesReduced = 0
  for (const name of names) {
    let bytes = entries[name]
    const image = name.startsWith(MEDIA_FOLDER[kind]) ? imageKind(bytes) : null

    if (image && bytes.length >= MIN_IMAGE_BYTES) {
      const smaller = await shrinkEmbeddedImage(bytes, image, mode)
      if (smaller) {
        bytes = smaller
        imagesReduced++
      }
    }
    // Images are already compressed, so deflating them again only costs time
    files[name] = [bytes, { level: image ? 0 : 9 }]
  }

  const output = zipSync(files)
  assertEntries(output, names)

  const pageCount = kind === 'pptx' ? names.filter((name) => SLIDE.test(name)).length : undefined
  if (output.length >= input.length) {
    return {
      outputPath: inputPath,
      originalSize: input.length,
      outputSize: input.length,
      reduced: false,
      pageCount,
      imagesReduced: 0,
    }
  }

  const outputPath = join(workDir, 'output')
  await writeFile(outputPath, output)
  return {
    outputPath,
    originalSize: input.length,
    outputSize: output.length,
    reduced: true,
    pageCount,
    imagesReduced,
  }
}

function unpack(data: Uint8Array): Unzipped {
  let entries = 0
  let unpackedBytes = 0
  try {
    return unzipSync(data, {
      filter: (file) => {
        entries++
        unpackedBytes += file.originalSize
        if (entries > MAX_ENTRIES || unpackedBytes > MAX_UNPACKED_BYTES) {
          throw new CompressionRejectedError('This document is too large to process.')
        }
        return true
      },
    })
  } catch (error) {
    if (error instanceof CompressionRejectedError) throw error
    throw new CompressionRejectedError('This document is damaged and cannot be read.')
  }
}

async function shrinkEmbeddedImage(data: Uint8Array, kind: ImageKind, mode: CompressionMode) {
  try {
    // The re-encoded image has no EXIF, and rotating the pixels instead
    // is only right if Office honours the tag. Either way the picture
    // could turn, so photos with an orientation tag are left alone.
    const { orientation } = await sharp(data).metadata()
    if (orientation && orientation !== 1) return null

    const candidate = await encodeImage(data, kind, mode, { autoOrient: false })
    return candidate && candidate.length < data.length ? candidate : null
  } catch {
    // An image sharp cannot read may still display in Office
    return null
  }
}

function assertEntries(zip: Uint8Array, expected: string[]) {
  const names: string[] = []
  unzipSync(zip, {
    filter: (file) => {
      names.push(file.name)
      return false
    },
  })
  if (names.length !== expected.length || names.some((name, i) => name !== expected[i])) {
    throw new Error('Repacked document does not match the original parts')
  }
}
