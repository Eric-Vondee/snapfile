import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { ApiRequest } from '@japa/api-client'
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { binaries, run } from '#services/pdf_tools'

/**
 * Twelve pages of plain text, written without stream compression so
 * every mode has something to save.
 */
const TEXT_POSTSCRIPT = `%!PS
/Times-Roman findfont 11 scalefont setfont
1 1 12 {
  /pg exch def
  72 740 moveto (Page ) show pg 3 string cvs show (: Quarterly report) show
  700 -14 90 { 72 exch moveto (The quick brown fox jumps over the lazy dog 0123456789.) show } for
  showpage
} for
`

async function tool(command: string, args: string[], cwd: string) {
  const result = await run(command, args, { cwd, timeoutMs: 60_000 })
  if (result.code !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

async function pageCount(path: string) {
  const stdout = await tool(binaries.qpdf, ['--show-npages', path], tmpdir())
  return Number(stdout.trim())
}

async function fileSize(path: string) {
  const { size } = await stat(path)
  return size
}

async function workDirs() {
  const entries = await readdir(tmpdir())
  return entries.filter((name) => name.startsWith('compress-pdf-'))
}

/**
 * Parse PDF responses into a Buffer so tests can inspect the bytes.
 */
ApiRequest.addParser('application/pdf', (res, callback) => {
  const chunks: Buffer[] = []
  res.on('data', (chunk: Buffer) => chunks.push(chunk))
  res.on('end', () => callback(null, Buffer.concat(chunks)))
})

test.group('Compress', (group) => {
  let dir: string
  const fixture = (name: string) => join(dir, name)

  group.setup(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pdf-fixtures-'))

    await writeFile(fixture('text.ps'), TEXT_POSTSCRIPT)
    await tool(
      binaries.gs,
      ['-q', '-sDEVICE=pdfwrite', '-dCompressPages=false', '-o', 'text.pdf', 'text.ps'],
      dir
    )

    // A "scan": two Letter pages, each a 300 dpi JPEG of a rendered text page
    await tool(
      binaries.gs,
      [
        '-q',
        '-sDEVICE=jpeg',
        '-r300',
        '-dJPEGQ=95',
        '-dLastPage=2',
        '-o',
        'scan-%d.jpg',
        'text.pdf',
      ],
      dir
    )
    const pages = [1, 2]
      .map(
        (n) =>
          `<< /PageSize [612 792] >> setpagedevice 0.24 0.24 scale (scan-${n}.jpg) viewJPEG showpage`
      )
      .join(' ')
    await tool(
      binaries.gs,
      [
        '-q',
        '-dNOSAFER',
        '-sDEVICE=pdfwrite',
        '-dPassThroughJPEGImages=true',
        '-o',
        'scanned.pdf',
        'viewjpeg.ps',
        '-c',
        pages,
      ],
      dir
    )

    // The same scan as produced by many phone apps: page size in points
    // equals the image size in pixels, so the image looks like 72 dpi
    const oversizedPages = [1, 2]
      .map(
        (n) =>
          `(scan-${n}.jpg) << /PageSize 2 index viewJPEGgetsize 2 array astore >> setpagedevice viewJPEG showpage`
      )
      .join(' ')
    await tool(
      binaries.gs,
      [
        '-q',
        '-dNOSAFER',
        '-sDEVICE=pdfwrite',
        '-dPassThroughJPEGImages=true',
        '-o',
        'oversized-scan.pdf',
        'viewjpeg.ps',
        '-c',
        oversizedPages,
      ],
      dir
    )

    await tool(
      binaries.qpdf,
      [
        '--object-streams=generate',
        '--recompress-flate',
        '--compression-level=9',
        'text.pdf',
        'optimized.pdf',
      ],
      dir
    )
    await tool(
      binaries.qpdf,
      ['--encrypt', 'user', 'owner', '256', '--', 'text.pdf', 'encrypted.pdf'],
      dir
    )
    await writeFile(fixture('malformed.pdf'), '%PDF-1.4\nnot really a pdf\n%%EOF\n')
    await writeFile(fixture('not-a-pdf.pdf'), 'hello')
    await writeFile(fixture('empty.pdf'), '')

    return () => rm(dir, { recursive: true, force: true })
  })

  group.each.teardown(async ({ context }) => {
    context.assert.deepEqual(await workDirs(), [], 'a work directory was left in tmp')
  })

  test('lossless keeps every page and reduces an uncompressed PDF', async ({ client, assert }) => {
    const response = await client
      .post('/compress')
      .withCsrfToken()
      .field('mode', 'lossless')
      .file('file', fixture('text.pdf'))

    response.assertStatus(200)
    response.assertHeader('x-reduced', 'true')
    response.assertHeader('x-page-count', '12')
    assert.include(response.header('content-disposition'), 'filename="text-compressed.pdf"')

    const output = join(dir, 'out-lossless.pdf')
    await writeFile(output, response.body())
    assert.equal(await pageCount(output), 12)
    assert.isBelow(Number(response.header('x-output-size')), await fileSize(fixture('text.pdf')))
  })

  test('balanced, medium and strong substantially shrink a scanned PDF', async ({
    client,
    assert,
  }) => {
    const originalSize = await fileSize(fixture('scanned.pdf'))
    const sizes: Record<string, number> = {}

    for (const mode of ['balanced', 'medium', 'strong']) {
      const response = await client
        .post('/compress')
        .withCsrfToken()
        .field('mode', mode)
        .file('file', fixture('scanned.pdf'))

      response.assertStatus(200)
      const output = join(dir, `out-scan-${mode}.pdf`)
      await writeFile(output, response.body())
      assert.equal(await pageCount(output), 2)
      sizes[mode] = response.body().length
    }

    assert.isBelow(sizes.balanced, originalSize / 2)
    assert.isBelow(sizes.medium, sizes.balanced)
    assert.isBelow(sizes.strong, sizes.medium)
  })

  test('fits oversized scanned pages to A4 so their images can shrink', async ({
    client,
    assert,
  }) => {
    const originalSize = await fileSize(fixture('oversized-scan.pdf'))

    const response = await client
      .post('/compress')
      .withCsrfToken()
      .field('mode', 'balanced')
      .file('file', fixture('oversized-scan.pdf'))

    response.assertStatus(200)
    response.assertHeader('x-pages-resized', '2')
    assert.isBelow(response.body().length, originalSize / 2)

    const output = join(dir, 'out-oversized-balanced.pdf')
    await writeFile(output, response.body())
    assert.equal(await pageCount(output), 2)
  })

  test('lossless never resizes pages', async ({ client }) => {
    const response = await client
      .post('/compress')
      .withCsrfToken()
      .field('mode', 'lossless')
      .file('file', fixture('oversized-scan.pdf'))

    response.assertStatus(200)
    response.assertHeader('x-pages-resized', '0')
  })

  test('text stays extractable after strong compression', async ({ client, assert }) => {
    const response = await client
      .post('/compress')
      .withCsrfToken()
      .field('mode', 'strong')
      .file('file', fixture('text.pdf'))

    response.assertStatus(200)
    const output = join(dir, 'out-text-strong.pdf')
    await writeFile(output, response.body())
    const text = await tool(
      binaries.gs,
      ['-q', '-sDEVICE=txtwrite', '-dLastPage=1', '-o', '-', output],
      dir
    )
    assert.include(text, 'The quick brown fox')
  })

  test('returns the original when {mode} cannot make it smaller')
    .with(['lossless', 'balanced', 'medium', 'strong'])
    .run(async ({ client, assert }, mode) => {
      const response = await client
        .post('/compress')
        .withCsrfToken()
        .field('mode', mode)
        .file('file', fixture('optimized.pdf'))

      response.assertStatus(200)
      response.assertHeader('x-reduced', 'false')
      assert.include(response.header('content-disposition'), 'filename="optimized.pdf"')
      assert.equal(response.body().length, await fileSize(fixture('optimized.pdf')))
    })

  test('rejects {file}')
    .with([
      {
        file: 'encrypted.pdf',
        error: 'This PDF is encrypted or password-protected. Remove the protection and try again.',
      },
      { file: 'malformed.pdf', error: 'This PDF is damaged and cannot be read.' },
      {
        file: 'not-a-pdf.pdf',
        error:
          'This file type is not supported. Choose a PDF, JPG, PNG, WebP, Word (.docx) or PowerPoint (.pptx) file.',
      },
      { file: 'empty.pdf', error: 'The file is empty.' },
    ])
    .run(async ({ client }, { file, error }) => {
      const response = await client
        .post('/compress')
        .withCsrfToken()
        .field('mode', 'balanced')
        .file('file', fixture(file))

      response.assertStatus(422)
      response.assertBody({ error })
    })

  test('rejects files over 100 MB', async ({ client }) => {
    const huge = Buffer.alloc(100 * 1024 * 1024 + 1)
    huge.write('%PDF-1.4\n')

    const response = await client
      .post('/compress')
      .withCsrfToken()
      .field('mode', 'balanced')
      .file('file', huge, { filename: 'huge.pdf' })

    response.assertStatus(413)
    response.assertBody({ error: 'The file is larger than 100 MB.' })
  })

  test('compresses a batch of files sent at the same time', async ({ client, assert }) => {
    // The page sends each file of a batch as its own request
    const batch = ['text.pdf', 'scanned.pdf', 'oversized-scan.pdf', 'text.pdf', 'optimized.pdf']
    const responses = await Promise.all(
      batch.map((file) =>
        client
          .post('/compress')
          .withCsrfToken()
          .field('mode', 'balanced')
          .file('file', fixture(file))
      )
    )

    for (const [index, response] of responses.entries()) {
      response.assertStatus(200)
      assert.equal(Number(response.header('content-length')), response.body().length)
      const output = join(dir, `out-batch-${index}.pdf`)
      await writeFile(output, response.body())
      assert.equal(await pageCount(output), await pageCount(fixture(batch[index])))
    }
    assert.deepEqual(
      responses.map((response) => response.header('x-reduced')),
      ['true', 'true', 'true', 'true', 'false']
    )
  })

  test('rejects an unknown mode', async ({ client }) => {
    const response = await client
      .post('/compress')
      .withCsrfToken()
      .field('mode', 'turbo')
      .file('file', fixture('text.pdf'))

    response.assertStatus(422)
    response.assertBody({ error: 'Choose a compression mode.' })
  })

  test('refuses an upload without a CSRF token', async ({ client, assert }) => {
    const response = await client
      .post('/compress')
      .redirects(0)
      .field('mode', 'balanced')
      .file('file', fixture('text.pdf'))

    assert.notEqual(response.status(), 200)
  })
})
