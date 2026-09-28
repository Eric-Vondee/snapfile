import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import type { HttpContext } from '@adonisjs/core/http'
import { compressImage, IMAGE_SETTINGS } from '#services/image_compressor'
import { compressOffice } from '#services/office_compressor'
import { detectTools, ToolTimeoutError } from '#services/pdf_tools'
import { readTotals, recordCompression } from '#services/usage_stats'
import { detectKind, FILE_KINDS, type FileKind } from '#services/file_kinds'
import { compressPdf, isPdfModeAvailable } from '#services/pdf_compressor'
import {
  CompressionRejectedError,
  INPUT_FILE,
  MAX_UPLOAD_BYTES,
  MODES,
  type CompressionMode,
  type CompressionResult,
} from '#services/compression'

export default class CompressionController {
  async create({ view, logger }: HttpContext) {
    const tools = await detectTools()
    const totals = await readTotals().catch((error) => {
      logger.warn({ err: error }, 'could not read usage totals')
      return { files: 0, people: 0 }
    })
    const pdfModes = MODES.filter((mode) => isPdfModeAvailable(mode, tools))

    const accept = Object.values(FILE_KINDS)
      .flatMap((kind) => [...kind.extensions.map((extension) => `.${extension}`), kind.contentType])
      .join(',')

    return view.render('pages/home', {
      tools,
      pdfModes,
      totals,
      fileKinds: FILE_KINDS,
      imageSettings: IMAGE_SETTINGS,
      accept,
      maxUploadBytes: MAX_UPLOAD_BYTES,
    })
  }

  /**
   * Multipart processing is manual for this route (see config/bodyparser.ts),
   * so the upload streams straight into a per-request work directory and
   * nothing is written to disk before CSRF validation has passed.
   */
  async store({ request, response, logger }: HttpContext) {
    const workDir = await mkdtemp(join(tmpdir(), 'compress-pdf-'))

    try {
      request.multipart.onFile('file', { size: MAX_UPLOAD_BYTES }, async (part, reportChunk) => {
        const filePath = join(workDir, INPUT_FILE)
        part.pause()
        part.on('data', reportChunk)
        await pipeline(part, createWriteStream(filePath))
        return { filePath }
      })
      await request.multipart.process()

      const mode = request.input('mode') as CompressionMode
      if (!MODES.includes(mode)) {
        throw new CompressionRejectedError('Choose a compression mode.')
      }

      const upload = request.file('file')
      if (!upload) {
        throw new CompressionRejectedError('Choose a file.')
      }
      if (!upload.isValid) {
        const tooLarge = upload.errors.some((error) => error.type === 'size')
        throw tooLarge
          ? new CompressionRejectedError('The file is larger than 50 MB.', 413)
          : new CompressionRejectedError('The upload could not be read. Try again.')
      }

      const kind = await detectKind(join(workDir, INPUT_FILE))
      const result = await compress(workDir, kind, mode)
      const body = await readFile(result.outputPath)

      logger.info({ kind, mode, ...result, outputPath: undefined }, 'compressed file')

      response
        .header('Content-Type', FILE_KINDS[kind].contentType)
        .header('Content-Disposition', attachmentHeader(upload.clientName, kind, result.reduced))
        .header('X-File-Kind', kind)
        .header('X-Original-Size', String(result.originalSize))
        .header('X-Output-Size', String(result.outputSize))
        .header('X-Reduced', result.reduced ? 'true' : 'false')

      const details = {
        'X-Page-Count': result.pageCount,
        'X-Pages-Resized': result.pagesResized,
        'X-Images-Reduced': result.imagesReduced,
        'X-Image-Width': result.width,
        'X-Image-Height': result.height,
      }
      for (const [name, value] of Object.entries(details)) {
        if (value !== undefined) response.header(name, String(value))
      }

      // Only files that were made smaller count, and stats never stand
      // in the way of a download
      if (result.reduced) {
        try {
          await recordCompression({
            kind,
            mode,
            originalSize: result.originalSize,
            outputSize: result.outputSize,
            visitorId: request.header('x-visitor-id'),
          })
          const totals = await readTotals()
          response
            .header('X-Total-Files', String(totals.files))
            .header('X-Total-People', String(totals.people))
        } catch (error) {
          logger.warn({ err: error }, 'could not record usage')
        }
      }

      return response.send(body)
    } catch (error) {
      if (error instanceof CompressionRejectedError) {
        return response.status(error.status).json({ error: error.message })
      }
      if (error instanceof ToolTimeoutError) {
        logger.warn({ err: error }, 'PDF compression timed out')
        return response
          .status(504)
          .json({ error: 'Processing took too long. Try a smaller file or Lossless mode.' })
      }
      logger.error({ err: error }, 'PDF compression failed')
      return response
        .status(500)
        .json({ error: 'Compression failed for this file. Try a different mode.' })
    } finally {
      // The response body is already in memory, so the upload and
      // every intermediate file can be removed now
      await rm(workDir, { recursive: true, force: true })
    }
  }
}

async function compress(
  workDir: string,
  kind: FileKind,
  mode: CompressionMode
): Promise<CompressionResult> {
  switch (kind) {
    case 'pdf':
      if (!isPdfModeAvailable(mode, await detectTools())) {
        throw new CompressionRejectedError(
          'The tools for this mode are not installed. Reload the page for instructions.',
          503
        )
      }
      return compressPdf(workDir, mode)
    case 'docx':
    case 'pptx':
      return compressOffice(workDir, kind, mode)
    default:
      return compressImage(workDir, kind, mode)
  }
}

const KNOWN_EXTENSIONS: string[] = Object.values(FILE_KINDS).flatMap((kind) => kind.extensions)

/**
 * Builds a Content-Disposition header named after the uploaded file,
 * with an ASCII fallback and an RFC 5987 UTF-8 name. The uploaded
 * extension is kept when it fits the detected kind (".jpeg", ".docm").
 */
function attachmentHeader(clientName: string, kind: FileKind, reduced: boolean) {
  const extensions: readonly string[] = FILE_KINDS[kind].extensions
  const match = clientName.match(/\.([^.]+)$/)
  const uploaded = match && KNOWN_EXTENSIONS.includes(match[1].toLowerCase()) ? match : null
  const extension =
    uploaded && extensions.includes(uploaded[1].toLowerCase()) ? uploaded[1] : extensions[0]
  const base = clientName.slice(0, uploaded?.index ?? clientName.length).trim() || 'document'
  const name = `${base}${reduced ? '-compressed' : ''}.${extension}`
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')

  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}
