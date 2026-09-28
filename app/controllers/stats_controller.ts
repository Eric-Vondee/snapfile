import type { HttpContext } from '@adonisjs/core/http'
import type { FileKind } from '#services/file_kinds'
import type { CompressionMode } from '#services/compression'
import { readStats, type UsageStats } from '#services/usage_stats'

const KIND_NAMES: Record<FileKind, string> = {
  pdf: 'PDF',
  jpeg: 'JPG',
  png: 'PNG',
  webp: 'WebP',
  docx: 'Word',
  pptx: 'PowerPoint',
}

const MODE_NAMES: Record<CompressionMode, string> = {
  lossless: 'Lossless',
  balanced: 'Balanced',
  medium: 'Medium',
  strong: 'Strong',
}

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

const format = {
  /**
   * Exact below 10,000, then compact: 1,284 / 12.9K / 1.2M.
   */
  count: (value: number) =>
    value < 10_000 ? value.toLocaleString('en-US') : compact.format(value),
  exact: (value: number) => value.toLocaleString('en-US'),
  bytes: (bytes: number) => {
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let value = bytes
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024
      unit++
    }
    return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`
  },
}

const dayLabel = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
})

export default class StatsController {
  async show({ view }: HttpContext) {
    const stats = await readStats()

    return view.render('pages/stats', {
      stats,
      daily: dailyChart(stats.daily),
      reduction: stats.originalBytes > 0 ? stats.savedBytes / stats.originalBytes : 0,
      maxKindFiles: Math.max(1, ...stats.kinds.map((row) => row.files)),
      maxModeFiles: Math.max(1, ...stats.modes.map((row) => row.files)),
      kindNames: KIND_NAMES,
      modeNames: MODE_NAMES,
      format,
    })
  }
}

/**
 * Columns and y-axis ticks for the files-per-day chart. Ticks step by
 * 1, 2 or 5 times a power of ten, about four of them, so the top of the
 * axis is a round number just above the busiest day.
 */
function dailyChart(daily: UsageStats['daily']) {
  const busiest = Math.max(1, ...daily.map((point) => point.files))
  const rawStep = Math.max(1, busiest / 4)
  const power = 10 ** Math.floor(Math.log10(rawStep))
  const step = [1, 2, 5, 10].map((factor) => factor * power).find((value) => value >= rawStep)!
  const top = Math.ceil(busiest / step) * step

  return {
    top,
    ticks: Array.from({ length: top / step + 1 }, (_, index) => index * step),
    points: daily.map((point) => ({
      label: dayLabel.format(new Date(`${point.day}T00:00:00Z`)),
      files: point.files,
    })),
  }
}
