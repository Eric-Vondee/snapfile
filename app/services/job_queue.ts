import { availableParallelism } from 'node:os'
import env from '#start/env'

/**
 * Runs jobs with at most `limit` at a time; the rest wait their turn in
 * arrival order.
 */
export function jobQueue(limit: number) {
  let running = 0
  const waiting: (() => void)[] = []

  return async function runQueued<T>(job: () => Promise<T>): Promise<T> {
    if (running < limit) {
      running++
    } else {
      // A finishing job hands its slot straight to the next one
      await new Promise<void>((resolve) => waiting.push(resolve))
    }
    try {
      return await job()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else running--
    }
  }
}

/**
 * Compressions across all requests share one queue. Ghostscript and qpdf
 * run as their own processes and sharp on its own threads, so each job
 * keeps about a core busy: running more jobs than there are cores only
 * slows every one of them down and multiplies memory use.
 */
export const runQueued = jobQueue(
  Math.max(1, env.get('COMPRESSION_CONCURRENCY') ?? availableParallelism())
)
