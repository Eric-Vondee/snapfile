import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { PDFDict, PDFDocument, PDFName, type PDFRef, PDFStream } from 'pdf-lib'
import { restoreSoftMaskGroups } from '#services/pdf_compressor'

/**
 * Builds a one-page PDF whose soft mask points at a form without the
 * transparency group, as left behind after qpdf drops Ghostscript's
 * `/Group -1 0 R`.
 */
async function pdfWithBrokenSoftMask(path: string) {
  const doc = await PDFDocument.create()
  const page = doc.addPage([200, 200])
  const form = doc.context.register(
    doc.context.stream('0 0 10 10 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10] })
  )
  const softMask = doc.context.obj({ Type: 'Mask', S: 'Alpha', G: form })
  page.node.setExtGState(PDFName.of('GS0'), doc.context.obj({ SMask: softMask }))
  await writeFile(path, await doc.save())
  return form
}

async function groupOf(path: string, formRef: PDFRef) {
  const doc = await PDFDocument.load(await readFile(path))
  const form = doc.context.lookup(formRef)
  return form instanceof PDFStream ? form.dict.lookup(PDFName.of('Group')) : undefined
}

test.group('restoreSoftMaskGroups', (group) => {
  let dir: string

  group.each.setup(async () => {
    dir = await mkdtemp(join(tmpdir(), 'soft-mask-'))
    return () => rm(dir, { recursive: true, force: true })
  })

  test('adds a transparency group to a soft mask form that lacks one', async ({ assert }) => {
    const path = join(dir, 'broken.pdf')
    const form = await pdfWithBrokenSoftMask(path)

    assert.equal(await restoreSoftMaskGroups(path), 1)

    const groupDict = await groupOf(path, form)
    assert.isTrue(groupDict instanceof PDFDict)
    assert.equal((groupDict as PDFDict).get(PDFName.of('S')), PDFName.of('Transparency'))
  })

  test('leaves a valid file untouched', async ({ assert }) => {
    const path = join(dir, 'valid.pdf')
    await pdfWithBrokenSoftMask(path)
    await restoreSoftMaskGroups(path)
    const repaired = await readFile(path)

    assert.equal(await restoreSoftMaskGroups(path), 0)
    assert.deepEqual(await readFile(path), repaired)
  })
})
