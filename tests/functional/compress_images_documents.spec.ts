import sharp from 'sharp'
import { tmpdir } from 'node:os'
import { test } from '@japa/runner'
import { readdir } from 'node:fs/promises'
import { ApiRequest } from '@japa/api-client'
import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import { FILE_KINDS } from '#services/file_kinds'

const UNSUPPORTED =
  'This file type is not supported. Choose a PDF, JPG, PNG, WebP, Word (.docx) or PowerPoint (.pptx) file.'

for (const kind of ['jpeg', 'png', 'webp', 'docx', 'pptx'] as const) {
  ApiRequest.addParser(FILE_KINDS[kind].contentType, (res, callback) => {
    const chunks: Buffer[] = []
    res.on('data', (chunk: Buffer) => chunks.push(chunk))
    res.on('end', () => callback(null, Buffer.concat(chunks)))
  })
}

/**
 * Random pixels barely compress, so every lossy mode has plenty to save.
 */
function noise(width: number, height: number, channels: 3 | 4 = 3) {
  return sharp({
    create: {
      width,
      height,
      channels,
      background: '#000',
      noise: { type: 'gaussian', mean: 128, sigma: 40 },
    },
  })
}

/**
 * A smooth gradient: PNG compresses it well once filtering is applied.
 */
function gradient(width: number, height: number) {
  const pixels = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3
      pixels[i] = (x * 255) / width
      pixels[i + 1] = (y * 255) / height
      pixels[i + 2] = 128
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
}

function officePackage(parts: Record<string, Uint8Array | string>, level: 0 | 9 = 0) {
  const files: Zippable = {}
  for (const [name, data] of Object.entries(parts)) {
    files[name] = [typeof data === 'string' ? strToU8(data) : data, { level }]
  }
  return Buffer.from(zipSync(files))
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'
const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8"?><w:document>${'<w:p><w:r><w:t>Quarterly report</w:t></w:r></w:p>'.repeat(2000)}</w:document>`

async function workDirs() {
  const entries = await readdir(tmpdir())
  return entries.filter((name) => name.startsWith('compress-pdf-'))
}

test.group('Compress images and documents', (group) => {
  let photo: Buffer
  let rotatedPhoto: Buffer
  let screenshot: Buffer
  let smallPng: Buffer

  group.setup(async () => {
    photo = await noise(3200, 2400).jpeg({ quality: 95 }).toBuffer()
    rotatedPhoto = await noise(3200, 2400)
      .jpeg({ quality: 95 })
      .withMetadata({ orientation: 6 })
      .toBuffer()
    screenshot = await gradient(1200, 800).png({ compressionLevel: 0 }).toBuffer()
    smallPng = await gradient(40, 40).png().toBuffer()
  })

  group.each.teardown(async ({ context }) => {
    context.assert.deepEqual(await workDirs(), [], 'a work directory was left in tmp')
  })

  test('balanced resizes a JPG photo and applies its orientation', async ({ client, assert }) => {
    const response = await client
      .post('/compress')
      .withCsrfToken()
      .field('mode', 'balanced')
      .file('file', rotatedPhoto, { filename: 'photo.JPG' })

    response.assertStatus(200)
    response.assertHeader('content-type', 'image/jpeg')
    response.assertHeader('x-file-kind', 'jpeg')
    response.assertHeader('x-reduced', 'true')
    // 3200x2400 rotated a quarter turn is shown as 2400x3200
    response.assertHeader('x-image-width', '1536')
    response.assertHeader('x-image-height', '2048')
    assert.include(response.header('content-disposition'), 'filename="photo-compressed.JPG"')

    const output = await sharp(response.body()).metadata()
    assert.equal(output.format, 'jpeg')
    assert.deepEqual([output.width, output.height], [1536, 2048])
    assert.isUndefined(output.orientation)
    assert.isBelow(response.body().length, rotatedPhoto.length / 4)
  })

  test('each lossy mode makes a JPG smaller than the last', async ({ client, assert }) => {
    const sizes: Record<string, number> = {}
    for (const mode of ['balanced', 'medium', 'strong']) {
      const response = await client
        .post('/compress')
        .withCsrfToken()
        .field('mode', mode)
        .file('file', photo, { filename: 'photo.jpg' })

      response.assertStatus(200)
      sizes[mode] = response.body().length
    }

    assert.isBelow(sizes.balanced, photo.length)
    assert.isBelow(sizes.medium, sizes.balanced)
    assert.isBelow(sizes.strong, sizes.medium)
  })

  test('lossless is refused for {kind}')
    .with([
      { kind: 'JPG', filename: 'photo.jpg', image: () => photo },
      { kind: 'WebP', filename: 'photo.webp', image: () => noise(400, 300).webp().toBuffer() },
    ])
    .run(async ({ client }, { filename, image }) => {
      const response = await client
        .post('/compress')
        .withCsrfToken()
        .field('mode', 'lossless')
        .file('file', await image(), { filename })

      response.assertStatus(422)
      response.assertBody({
        error: 'Lossless mode only works for PNG images. Choose Balanced for JPG and WebP.',
      })
    })

  test('lossless shrinks a PNG without changing a pixel', async ({ client, assert }) => {
    const response = await client
      .post('/compress')
      .withCsrfToken()
      .field('mode', 'lossless')
      .file('file', screenshot, { filename: 'screenshot.png' })

    response.assertStatus(200)
    response.assertHeader('x-reduced', 'true')
    assert.isBelow(response.body().length, screenshot.length)

    const [before, after] = await Promise.all(
      [screenshot, response.body()].map((image) => sharp(image).raw().toBuffer())
    )
    assert.isTrue(before.equals(after), 'pixels changed')
  })

  test('lossless leaves a 16-bit PNG untouched', async ({ client, assert }) => {
    const deep = await gradient(300, 200)
      .toColourspace('rgb16')
      .png({ compressionLevel: 0 })
      .toBuffer()

    const response = await client
      .post('/compress')
      .withCsrfToken()
      .field('mode', 'lossless')
      .file('file', deep, { filename: 'deep.png' })

    response.assertStatus(200)
    response.assertHeader('x-reduced', 'false')
    assert.isTrue(response.body().equals(deep))
  })

  test('balanced reduces a PNG to a palette and keeps transparency', async ({ client, assert }) => {
    const transparent = await noise(1000, 800, 4).png().toBuffer()

    const response = await client
      .post('/compress')
      .withCsrfToken()
      .field('mode', 'balanced')
      .file('file', transparent, { filename: 'logo.png' })

    response.assertStatus(200)
    assert.isBelow(response.body().length, transparent.length / 2)
    const output = await sharp(response.body()).metadata()
    assert.equal(output.format, 'png')
    assert.isTrue(output.hasAlpha)
  })

  test('keeps every frame of an animated WebP', async ({ client, assert }) => {
    const frames = await Promise.all([0, 1, 2].map(() => noise(1600, 1000).png().toBuffer()))
    const animated = await sharp(frames, { join: { animated: true } })
      .webp({ quality: 95 })
      .toBuffer()

    const response = await client
      .post('/compress')
      .withCsrfToken()
      .field('mode', 'strong')
      .file('file', animated, { filename: 'loop.webp' })

    response.assertStatus(200)
    response.assertHeader('x-reduced', 'true')
    response.assertHeader('x-image-width', '1280')
    response.assertHeader('x-image-height', '800')
    const output = await sharp(response.body(), { animated: true }).metadata()
    assert.equal(output.pages, 3)
  })

  test('compresses the images in a Word file and copies everything else', async ({
    client,
    assert,
  }) => {
    const docx = officePackage({
      '[Content_Types].xml': CONTENT_TYPES,
      'word/document.xml': DOCUMENT_XML,
      'word/media/image1.jpeg': photo,
      'word/media/image2.png': smallPng,
      'word/media/image3.jpeg': rotatedPhoto,
    })

    const response = await client
      .post('/compress')
      .withCsrfToken()
      .field('mode', 'balanced')
      .file('file', docx, { filename: 'report.docx' })

    response.assertStatus(200)
    response.assertHeader('x-file-kind', 'docx')
    response.assertHeader('x-images-reduced', '1')
    assert.include(response.header('content-disposition'), 'filename="report-compressed.docx"')

    const parts = unzipSync(response.body())
    assert.deepEqual(Object.keys(parts), [
      '[Content_Types].xml',
      'word/document.xml',
      'word/media/image1.jpeg',
      'word/media/image2.png',
      'word/media/image3.jpeg',
    ])
    assert.equal(Buffer.from(parts['word/document.xml']).toString(), DOCUMENT_XML)
    // Too small to bother with, and a photo with an orientation tag
    assert.isTrue(Buffer.from(parts['word/media/image2.png']).equals(smallPng))
    assert.isTrue(Buffer.from(parts['word/media/image3.jpeg']).equals(rotatedPhoto))

    const image = await sharp(parts['word/media/image1.jpeg']).metadata()
    assert.equal(image.format, 'jpeg')
    assert.deepEqual([image.width, image.height], [2048, 1536])
  })

  test('counts slides and compresses the images in a PowerPoint file', async ({
    client,
    assert,
  }) => {
    const slide = '<p:sld><p:cSld><p:spTree/></p:cSld></p:sld>'
    const pptx = officePackage({
      '[Content_Types].xml': CONTENT_TYPES,
      'ppt/presentation.xml': '<p:presentation/>',
      'ppt/slides/slide1.xml': slide,
      'ppt/slides/slide2.xml': slide,
      'ppt/slides/_rels/slide1.xml.rels': '<Relationships/>',
      'ppt/media/image1.png': await noise(1800, 1200).png().toBuffer(),
    })

    const response = await client
      .post('/compress')
      .withCsrfToken()
      .field('mode', 'medium')
      .file('file', pptx, { filename: 'deck.pptx' })

    response.assertStatus(200)
    response.assertHeader('x-file-kind', 'pptx')
    response.assertHeader('x-page-count', '2')
    response.assertHeader('x-images-reduced', '1')
    assert.isBelow(response.body().length, pptx.length / 2)

    const image = await sharp(unzipSync(response.body())['ppt/media/image1.png']).metadata()
    assert.deepEqual([image.width, image.height], [1600, 1067])
  })

  test('lossless repacks a Word file without touching JPG images', async ({ client, assert }) => {
    const docx = officePackage({
      '[Content_Types].xml': CONTENT_TYPES,
      'word/document.xml': DOCUMENT_XML,
      'word/media/image1.jpeg': photo,
    })

    const response = await client
      .post('/compress')
      .withCsrfToken()
      .field('mode', 'lossless')
      .file('file', docx, { filename: 'report.docx' })

    response.assertStatus(200)
    response.assertHeader('x-reduced', 'true')
    response.assertHeader('x-images-reduced', '0')
    const parts = unzipSync(response.body())
    assert.isTrue(Buffer.from(parts['word/media/image1.jpeg']).equals(photo))
  })

  test('returns the original when a document cannot be made smaller', async ({
    client,
    assert,
  }) => {
    const docx = officePackage(
      { '[Content_Types].xml': CONTENT_TYPES, 'word/document.xml': DOCUMENT_XML },
      9
    )

    const response = await client
      .post('/compress')
      .withCsrfToken()
      .field('mode', 'strong')
      .file('file', docx, { filename: 'report.docx' })

    response.assertStatus(200)
    response.assertHeader('x-reduced', 'false')
    assert.include(response.header('content-disposition'), 'filename="report.docx"')
    assert.isTrue(response.body().equals(docx))
  })

  test('rejects a document that would unpack to more than the limit', async ({ client }) => {
    const docx = officePackage({
      '[Content_Types].xml': CONTENT_TYPES,
      'word/document.xml': DOCUMENT_XML,
    })
    // Claim 300 MB in the central directory entry of the last part
    const entry = docx.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    docx.writeUInt32LE(300 * 1024 * 1024, entry + 24)

    const response = await client
      .post('/compress')
      .withCsrfToken()
      .field('mode', 'balanced')
      .file('file', docx, { filename: 'bomb.docx' })

    response.assertStatus(422)
    response.assertBody({ error: 'This document is too large to process.' })
  })

  test('rejects {name}')
    .with([
      {
        name: 'a damaged image',
        filename: 'broken.jpg',
        file: () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]),
        error: 'This image is damaged and cannot be read.',
      },
      {
        name: 'a legacy Office file',
        filename: 'old.doc',
        file: () =>
          Buffer.concat([
            Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
            Buffer.alloc(512),
          ]),
        error:
          'Older .doc and .ppt files and password-protected documents cannot be compressed. Save it as .docx or .pptx without a password and try again.',
      },
      {
        name: 'a spreadsheet',
        filename: 'numbers.xlsx',
        file: () =>
          officePackage({ '[Content_Types].xml': CONTENT_TYPES, 'xl/workbook.xml': '<workbook/>' }),
        error: UNSUPPORTED,
      },
      {
        name: 'a damaged document',
        filename: 'broken.docx',
        file: () => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]),
        error: 'This document is damaged and cannot be read.',
      },
    ])
    .run(async ({ client }, { filename, file, error }) => {
      const response = await client
        .post('/compress')
        .withCsrfToken()
        .field('mode', 'balanced')
        .file('file', file(), { filename })

      response.assertStatus(422)
      response.assertBody({ error })
    })
})
