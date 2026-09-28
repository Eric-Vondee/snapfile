import { unzipSync } from 'fflate'
import { open, readFile } from 'node:fs/promises'
import { CompressionRejectedError } from '#services/compression'

/**
 * The first extension is used when the uploaded name does not end in one
 * of the kind's extensions.
 */
export const FILE_KINDS = {
  pdf: { contentType: 'application/pdf', extensions: ['pdf'] },
  jpeg: { contentType: 'image/jpeg', extensions: ['jpg', 'jpeg'] },
  png: { contentType: 'image/png', extensions: ['png'] },
  webp: { contentType: 'image/webp', extensions: ['webp'] },
  docx: {
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extensions: ['docx', 'docm'],
  },
  pptx: {
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extensions: ['pptx', 'pptm'],
  },
} as const

export type FileKind = keyof typeof FILE_KINDS
export type ImageKind = Extract<FileKind, 'jpeg' | 'png' | 'webp'>
export type OfficeKind = Extract<FileKind, 'docx' | 'pptx'>

const UNSUPPORTED_MESSAGE =
  'This file type is not supported. Choose a PDF, JPG, PNG, WebP, Word (.docx) or PowerPoint (.pptx) file.'

export function imageKind(bytes: Uint8Array): ImageKind | null {
  const ascii = (start: number, end: number) =>
    Buffer.from(bytes.subarray(start, end)).toString('latin1')

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (ascii(0, 8) === '\x89PNG\r\n\x1a\n') return 'png'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp'
  return null
}

/**
 * Identifies the uploaded file from its contents rather than its name.
 */
export async function detectKind(path: string): Promise<FileKind> {
  const head = await readHead(path, 1024)
  if (head.length === 0) {
    throw new CompressionRejectedError('The file is empty.')
  }

  const image = imageKind(head)
  if (image) return image

  // ZIP local file header: Word and PowerPoint files are ZIP packages
  if (head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    return officeKind(path)
  }
  // OLE compound file: pre-2007 .doc/.ppt, or an encrypted .docx/.pptx
  if (head.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    throw new CompressionRejectedError(
      'Older .doc and .ppt files and password-protected documents cannot be compressed. Save it as .docx or .pptx without a password and try again.'
    )
  }
  // The PDF spec allows the "%PDF-" marker anywhere in the first 1024 bytes
  if (head.includes('%PDF-')) return 'pdf'

  throw new CompressionRejectedError(UNSUPPORTED_MESSAGE)
}

async function officeKind(path: string): Promise<OfficeKind> {
  const names = new Set<string>()
  try {
    // Only the central directory is read; returning false skips inflating
    unzipSync(await readFile(path), {
      filter: (file) => {
        names.add(file.name)
        return false
      },
    })
  } catch {
    throw new CompressionRejectedError('This document is damaged and cannot be read.')
  }

  if (names.has('[Content_Types].xml')) {
    if (names.has('word/document.xml')) return 'docx'
    if (names.has('ppt/presentation.xml')) return 'pptx'
  }
  throw new CompressionRejectedError(UNSUPPORTED_MESSAGE)
}

async function readHead(path: string, length: number) {
  const handle = await open(path, 'r')
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(length), 0, length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}
