import { createHmac } from 'node:crypto'
import env from '#start/env'
import db from '@adonisjs/lucid/services/db'
import type { FileKind } from '#services/file_kinds'
import { MODES, type CompressionMode } from '#services/compression'

export interface UsageTotals {
  files: number
  people: number
}

export interface UsageStats extends UsageTotals {
  originalBytes: number
  savedBytes: number
  /**
   * Files per UTC day, oldest first, including days with none.
   */
  daily: { day: string; files: number }[]
  /**
   * Kinds that have been compressed at least once, most files first.
   */
  kinds: { kind: FileKind; files: number; savedBytes: number }[]
  /**
   * Every mode in menu order, including unused ones.
   */
  modes: { mode: CompressionMode; files: number }[]
}

export const DAILY_DAYS = 30

/**
 * The browser sends a random UUID it keeps in local storage.
 */
const VISITOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Records a file that was made smaller and, when the browser sent a
 * valid ID, the person who compressed it. Only a keyed hash of the ID
 * is stored, so the table cannot be matched back to a browser without
 * the app key. Rotating APP_KEY therefore starts the people count over.
 */
export async function recordCompression(compression: {
  kind: FileKind
  mode: CompressionMode
  originalSize: number
  outputSize: number
  visitorId?: string
}) {
  await db.table('compressions').insert({
    kind: compression.kind,
    mode: compression.mode,
    original_size: compression.originalSize,
    output_size: compression.outputSize,
  })

  if (compression.visitorId && VISITOR_ID.test(compression.visitorId)) {
    const id = createHmac('sha256', env.get('APP_KEY').release())
      .update(compression.visitorId.toLowerCase())
      .digest('hex')
    await db.table('visitors').insert({ id }).onConflict('id').ignore()
  }
}

export async function readTotals(): Promise<UsageTotals> {
  const [files, people] = await Promise.all([
    db.from('compressions').count('* as total').first(),
    db.from('visitors').count('* as total').first(),
  ])
  return { files: Number(files?.total ?? 0), people: Number(people?.total ?? 0) }
}

/**
 * Everything the stats page shows. SQLite stores `created_at` as UTC text,
 * so days are UTC days.
 */
export async function readStats(): Promise<UsageStats> {
  const [sizes, visitors, dailyRows, kindRows, modeRows] = await Promise.all([
    db
      .from('compressions')
      .count('* as files')
      .sum('original_size as original')
      .sum('output_size as output')
      .first(),
    db.from('visitors').count('* as total').first(),
    db
      .from('compressions')
      .select(db.raw('date(created_at) as day'))
      .count('* as files')
      .whereRaw(`created_at >= datetime('now', 'start of day', '-${DAILY_DAYS - 1} days')`)
      .groupBy('day'),
    db
      .from('compressions')
      .select('kind', db.raw('sum(original_size - output_size) as saved'))
      .count('* as files')
      .groupBy('kind')
      .orderBy('files', 'desc'),
    db.from('compressions').select('mode').count('* as files').groupBy('mode'),
  ])

  const perDay = new Map(dailyRows.map((row) => [row.day as string, Number(row.files)]))
  const today = new Date()
  const daily = Array.from({ length: DAILY_DAYS }, (_, index) => {
    const date = new Date(
      Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate() - (DAILY_DAYS - 1 - index)
      )
    )
    const day = date.toISOString().slice(0, 10)
    return { day, files: perDay.get(day) ?? 0 }
  })

  const perMode = new Map(modeRows.map((row) => [row.mode as string, Number(row.files)]))
  const originalBytes = Number(sizes?.original ?? 0)

  return {
    files: Number(sizes?.files ?? 0),
    people: Number(visitors?.total ?? 0),
    originalBytes,
    savedBytes: originalBytes - Number(sizes?.output ?? 0),
    daily,
    kinds: kindRows.map((row) => ({
      kind: row.kind as FileKind,
      files: Number(row.files),
      savedBytes: Number(row.saved),
    })),
    modes: MODES.map((mode) => ({ mode, files: perMode.get(mode) ?? 0 })),
  }
}
