import { join } from 'node:path'
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFStream } from 'pdf-lib'
import { open, readFile, stat, writeFile } from 'node:fs/promises'
import { binaries, run, type ToolName, type ToolStatus } from '#services/pdf_tools'
import {
  CompressionRejectedError,
  INPUT_FILE,
  type CompressionMode,
  type CompressionResult,
  type LossyMode,
} from '#services/compression'

const TOOL_TIMEOUT_MS = 120_000

// A4 in points
const A4 = { short: 595, long: 842 }
const OVERSIZED_LONG_SIDE = A4.long * 1.5

// qpdf is always needed to validate the input and the generated file
const REQUIRED_TOOLS: Record<CompressionMode, ToolName[]> = {
  lossless: ['qpdf'],
  balanced: ['qpdf', 'gs'],
  medium: ['qpdf', 'gs'],
  strong: ['qpdf', 'gs'],
}

const GHOSTSCRIPT_SETTINGS: Record<LossyMode, { preset: string; dpi: number }> = {
  balanced: { preset: '/ebook', dpi: 150 },
  medium: { preset: '/ebook', dpi: 100 },
  strong: { preset: '/screen', dpi: 72 },
}

export function isPdfModeAvailable(mode: CompressionMode, tools: ToolStatus) {
  return REQUIRED_TOOLS[mode].every((tool) => tools[tool] !== null)
}

// qpdf exit codes: 0 = success, 2 = errors, 3 = warnings only
const QPDF_ERROR = 2

export async function compressPdf(
  workDir: string,
  mode: CompressionMode
): Promise<CompressionResult> {
  const input = INPUT_FILE
  const output = 'output.pdf'
  const inputPath = join(workDir, input)
  const outputPath = join(workDir, output)

  const { size: originalSize } = await stat(inputPath)
  if (originalSize === 0) {
    throw new CompressionRejectedError('The file is empty.')
  }
  if (!(await hasPdfHeader(inputPath))) {
    throw new CompressionRejectedError('This file is not a PDF.')
  }
  await assertNotEncrypted(workDir, input)
  await assertReadable(workDir, input)
  const pageCount = await countPages(workDir, input)

  let source = input
  let pagesResized = 0
  if (mode !== 'lossless') {
    pagesResized = await fitOversizedPages(inputPath, join(workDir, 'fitted.pdf'))
    if (pagesResized > 0) source = 'fitted.pdf'
  }

  await runCompression(workDir, mode, source, output)

  const candidate = await stat(outputPath).catch(() => null)
  if (!candidate || candidate.size === 0) {
    throw new Error(`${mode} compression produced an invalid PDF`)
  }

  // A candidate that is not smaller is thrown away, so it is not worth
  // the full check, which takes seconds on a large file
  if (candidate.size >= originalSize) {
    return {
      outputPath: inputPath,
      originalSize,
      outputSize: originalSize,
      reduced: false,
      pageCount,
      pagesResized: 0,
    }
  }

  // Stricter than the input check: an output with any qpdf warning is
  // never returned, since viewers like Acrobat may refuse to show it
  if (!(await isCleanPdf(workDir, output))) {
    throw new Error(`${mode} compression produced an invalid PDF`)
  }
  const outputPageCount = await countPages(workDir, output)
  if (outputPageCount !== pageCount) {
    throw new Error(`${mode} compression changed page count ${pageCount} -> ${outputPageCount}`)
  }

  return {
    outputPath,
    originalSize,
    outputSize: candidate.size,
    reduced: true,
    pageCount,
    pagesResized,
  }
}

/**
 * Scanner and photo-to-PDF apps often set the page size to the image's
 * pixel size, e.g. a 2200x2800 pt (31x39 inch) page. Ghostscript then
 * sees a 72 dpi image and never downsamples it. Scaling such pages to
 * fit A4 (keeping aspect ratio and orientation) exposes the real image
 * resolution. Returns how many pages were scaled; 0 means `outputPath`
 * was not written.
 */
async function fitOversizedPages(inputPath: string, outputPath: string) {
  let doc: PDFDocument
  try {
    doc = await PDFDocument.load(await readFile(inputPath), { updateMetadata: false })
  } catch {
    // pdf-lib is stricter than Ghostscript; compress the file as-is
    return 0
  }

  let resized = 0
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize()
    const long = Math.max(width, height)
    const short = Math.min(width, height)
    if (long <= OVERSIZED_LONG_SIDE) continue

    const factor = Math.min(A4.short / short, A4.long / long)
    page.scale(factor, factor)
    resized++
  }

  if (resized > 0) {
    await writeFile(outputPath, await doc.save({ useObjectStreams: false }))
  }
  return resized
}

/**
 * Gives every soft mask's `G` form the transparency group the PDF spec
 * requires. Ghostscript 10.08 sometimes writes `/Group -1 0 R` there; qpdf
 * reads that as null, which leaves the mask ignored (an icon becomes a
 * solid block) and makes Acrobat refuse the page. Returns how many masks
 * were repaired; the file is only rewritten when that is more than 0.
 */
export async function restoreSoftMaskGroups(path: string) {
  const doc = await PDFDocument.load(await readFile(path), { updateMetadata: false })
  const softMaskTypes = [PDFName.of('Alpha'), PDFName.of('Luminosity')]

  let repaired = 0
  const visit = (value: unknown) => {
    const dict = value instanceof PDFStream ? value.dict : value
    if (dict instanceof PDFArray) {
      dict.asArray().forEach(visit)
      return
    }
    if (!(dict instanceof PDFDict)) return

    // Soft masks can be standalone objects or nested directly inside an
    // ExtGState, so direct children are searched too (references are not
    // followed; every indirect object is visited on its own)
    for (const child of dict.values()) visit(child)

    const type = dict.get(PDFName.of('S'))
    if (!(type instanceof PDFName) || !softMaskTypes.includes(type)) return

    const form = dict.lookup(PDFName.of('G'))
    if (!(form instanceof PDFStream)) return
    if (form.dict.lookup(PDFName.of('Group')) instanceof PDFDict) return

    form.dict.set(PDFName.of('Group'), doc.context.obj({ Type: 'Group', S: 'Transparency' }))
    repaired++
  }
  for (const [, object] of doc.context.enumerateIndirectObjects()) visit(object)

  if (repaired > 0) {
    await writeFile(path, await doc.save())
  }
  return repaired
}

// The PDF spec allows the "%PDF-" marker anywhere in the first 1024 bytes
async function hasPdfHeader(path: string) {
  const handle = await open(path, 'r')
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(1024), 0, 1024, 0)
    return buffer.subarray(0, bytesRead).includes('%PDF-')
  } finally {
    await handle.close()
  }
}

async function assertNotEncrypted(cwd: string, file: string) {
  // Exits 0 when the file is encrypted, 2 when it is not
  const result = await qpdf(cwd, ['--is-encrypted', file])
  if (result.code === 0) {
    throw new CompressionRejectedError(
      'This PDF is encrypted or password-protected. Remove the protection and try again.'
    )
  }
}

async function assertReadable(cwd: string, file: string) {
  if (!(await isValidPdf(cwd, file))) {
    throw new CompressionRejectedError('This PDF is damaged and cannot be read.')
  }
}

/**
 * Reads every object into a throwaway copy with stream data untouched.
 * That rejects broken cross-reference tables and unreadable objects in
 * milliseconds, where `qpdf --check` also decodes every image and takes
 * seconds on a large scan. Damage inside a stream still fails safely
 * later, when Ghostscript or qpdf rewrites the file.
 */
async function isValidPdf(cwd: string, file: string) {
  const result = await qpdf(cwd, ['--stream-data=preserve', file, 'readable.pdf'])
  return result.code !== null && result.code !== QPDF_ERROR
}

/**
 * The generated file gets the full check: any warning means a viewer
 * such as Acrobat may refuse it.
 */
async function isCleanPdf(cwd: string, file: string) {
  const result = await qpdf(cwd, ['--check', file])
  return result.code === 0
}

async function countPages(cwd: string, file: string) {
  const result = await qpdf(cwd, ['--show-npages', file])
  const pages = Number.parseInt(result.stdout.trim(), 10)
  if (result.code === QPDF_ERROR || !Number.isInteger(pages) || pages < 1) {
    throw new CompressionRejectedError('This PDF has no readable pages.')
  }
  return pages
}

async function runCompression(cwd: string, mode: CompressionMode, input: string, output: string) {
  if (mode === 'lossless') {
    const result = await qpdf(cwd, [
      '--object-streams=generate',
      '--recompress-flate',
      '--compression-level=9',
      input,
      output,
    ])
    if (result.code === QPDF_ERROR) {
      throw new CompressionRejectedError('qpdf could not rewrite this PDF.')
    }
    return
  }

  const { preset, dpi } = GHOSTSCRIPT_SETTINGS[mode]
  const result = await run(
    binaries.gs,
    [
      '-sDEVICE=pdfwrite',
      '-dSAFER',
      '-dNOPAUSE',
      '-dBATCH',
      '-dQUIET',
      `-dPDFSETTINGS=${preset}`,
      `-dColorImageResolution=${dpi}`,
      `-dGrayImageResolution=${dpi}`,
      // Presets only downsample images above 1.5x their target dpi (225 dpi
      // for /ebook); reduce everything above the target instead
      '-dColorImageDownsampleThreshold=1.0',
      '-dGrayImageDownsampleThreshold=1.0',
      '-dMonoImageDownsampleThreshold=1.0',
      '-sOutputFile=ghostscript.pdf',
      input,
    ],
    { cwd, timeoutMs: TOOL_TIMEOUT_MS }
  )
  if (result.code !== 0) {
    throw new CompressionRejectedError(
      'Ghostscript could not process this PDF. Try Lossless mode instead.'
    )
  }

  // Ghostscript's output is not always valid (see restoreSoftMaskGroups).
  // Rewriting it with qpdf repairs broken references and packs objects
  // into object streams; the soft-mask pass then restores what qpdf had
  // to drop.
  const cleanup = await qpdf(cwd, [
    '--object-streams=generate',
    '--compression-level=9',
    'ghostscript.pdf',
    output,
  ])
  if (cleanup.code === QPDF_ERROR) {
    throw new Error(`qpdf could not rewrite Ghostscript output: ${cleanup.stderr}`)
  }
  await restoreSoftMaskGroups(join(cwd, output))
}

function qpdf(cwd: string, args: string[]) {
  return run(binaries.qpdf, args, { cwd, timeoutMs: TOOL_TIMEOUT_MS })
}
