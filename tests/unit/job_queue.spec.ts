import { test } from '@japa/runner'
import { jobQueue } from '#services/job_queue'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

// Lets every pending promise callback run
const settle = () => new Promise((resolve) => setImmediate(resolve))

test.group('Job queue', () => {
  test('runs at most the limit at once and starts the rest in order', async ({ assert }) => {
    const runQueued = jobQueue(2)
    const jobs = [0, 1, 2, 3, 4].map(() => deferred())
    const started: number[] = []
    const results = jobs.map((job, index) =>
      runQueued(async () => {
        started.push(index)
        await job.promise
        return index
      })
    )

    await settle()
    assert.deepEqual(started, [0, 1])

    jobs[1].resolve()
    await settle()
    assert.deepEqual(started, [0, 1, 2])

    jobs[0].resolve()
    jobs[2].resolve()
    await settle()
    assert.deepEqual(started, [0, 1, 2, 3, 4])

    jobs[3].resolve()
    jobs[4].resolve()
    assert.deepEqual(await Promise.all(results), [0, 1, 2, 3, 4])
  })

  test('frees the slot of a job that fails', async ({ assert }) => {
    const runQueued = jobQueue(1)
    const failed = runQueued(async () => {
      throw new Error('broken file')
    })
    const next = runQueued(async () => 'done')

    await assert.rejects(() => failed, 'broken file')
    assert.equal(await next, 'done')
  })
})
