import sharp from 'sharp'
import { randomUUID } from 'node:crypto'
import { test } from '@japa/runner'
import type { ApiClient } from '@japa/api-client'
import { strToU8, zipSync } from 'fflate'
import { readStats, readTotals } from '#services/usage_stats'

test.group('Usage stats', (group) => {
  let photo: Buffer

  group.setup(async () => {
    photo = await sharp({
      create: {
        width: 800,
        height: 600,
        channels: 3,
        background: '#000',
        noise: { type: 'gaussian', mean: 128, sigma: 40 },
      },
    })
      .jpeg({ quality: 95 })
      .toBuffer()
  })

  function compressPhoto(client: ApiClient, visitorId?: string) {
    const request = client
      .post('/compress')
      .withCsrfToken()
      .field('mode', 'balanced')
      .file('file', photo, { filename: 'photo.jpg' })
    return visitorId ? request.header('x-visitor-id', visitorId) : request
  }

  test('counts each file and each person once', async ({ client }) => {
    const before = await readTotals()
    const visitor = randomUUID()

    const first = await compressPhoto(client, visitor)
    first.assertStatus(200)
    first.assertHeader('x-total-files', String(before.files + 1))
    first.assertHeader('x-total-people', String(before.people + 1))

    const second = await compressPhoto(client, visitor.toUpperCase())
    second.assertHeader('x-total-files', String(before.files + 2))
    second.assertHeader('x-total-people', String(before.people + 1))

    const someoneElse = await compressPhoto(client, randomUUID())
    someoneElse.assertHeader('x-total-people', String(before.people + 2))
  })

  test('counts the file but not the person without a valid ID', async ({ client }) => {
    const before = await readTotals()

    const withoutId = await compressPhoto(client)
    withoutId.assertHeader('x-total-files', String(before.files + 1))
    withoutId.assertHeader('x-total-people', String(before.people))

    const invalidId = await compressPhoto(client, 'not-a-uuid')
    invalidId.assertHeader('x-total-files', String(before.files + 2))
    invalidId.assertHeader('x-total-people', String(before.people))
  })

  test('does not count a file that could not be made smaller', async ({ client, assert }) => {
    const before = await readTotals()
    const docx = zipSync(
      {
        '[Content_Types].xml': strToU8('<Types/>'),
        'word/document.xml': strToU8('<w:document/>'),
      },
      { level: 9 }
    )

    const response = await client
      .post('/compress')
      .withCsrfToken()
      .header('x-visitor-id', randomUUID())
      .field('mode', 'strong')
      .file('file', Buffer.from(docx), { filename: 'short.docx' })

    response.assertStatus(200)
    response.assertHeader('x-reduced', 'false')
    assert.isUndefined(response.header('x-total-files'))
    assert.deepEqual(await readTotals(), before)
  })

  test('shows the totals on the page', async ({ client, assert }) => {
    await compressPhoto(client, randomUUID())
    const { files, people } = await readTotals()

    const response = await client.get('/')
    response.assertStatus(200)
    assert.include(
      response.text(),
      `&quot;totals&quot;:{&quot;files&quot;:${files},&quot;people&quot;:${people}}`
    )
  })

  test('the stats page shows totals, days, file types and modes', async ({ client, assert }) => {
    await compressPhoto(client, randomUUID())
    const stats = await readStats()

    assert.lengthOf(stats.daily, 30)
    assert.equal(stats.daily.at(-1)!.day, new Date().toISOString().slice(0, 10))
    // Every row in the test database was written today
    assert.equal(
      stats.daily.reduce((sum, point) => sum + point.files, 0),
      stats.files
    )
    assert.isAbove(stats.savedBytes, 0)
    assert.isAtLeast(stats.kinds.find((row) => row.kind === 'jpeg')!.files, 1)
    assert.deepEqual(
      stats.modes.map((row) => row.mode),
      ['lossless', 'balanced', 'medium', 'strong']
    )

    const response = await client.get('/stats')
    response.assertStatus(200)
    assert.include(response.text(), `<dd class="kpi-value">${stats.files}</dd>`)
    assert.include(response.text(), `<dd class="kpi-value">${stats.people}</dd>`)
    assert.include(response.text(), 'Files per day')
  })
})
