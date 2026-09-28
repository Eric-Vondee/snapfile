import { spawn } from 'node:child_process'
import env from '#start/env'

/**
 * Executables used for PDF processing. Override with QPDF_BIN / GS_BIN
 * when they are not on the PATH of the process running the server.
 */
export const binaries = {
  qpdf: env.get('QPDF_BIN') ?? 'qpdf',
  gs: env.get('GS_BIN') ?? 'gs',
}

export type ToolName = keyof typeof binaries

export class ToolTimeoutError extends Error {}

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

/**
 * Only the first few KB of output are kept, which is enough for page
 * counts and error messages without buffering runaway tool output.
 */
const MAX_CAPTURED_OUTPUT = 64 * 1024

/**
 * Runs an executable with an argument array (never through a shell) and
 * kills it once the timeout elapses.
 */
export function run(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number }
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs)

    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_CAPTURED_OUTPUT) stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_CAPTURED_OUTPUT) stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) {
        reject(new ToolTimeoutError(`${command} timed out after ${options.timeoutMs}ms`))
        return
      }
      resolve({ code, stdout, stderr })
    })
  })
}

/**
 * Installed version of each tool, or null when it cannot be executed.
 */
export type ToolStatus = Record<ToolName, string | null>

let detected: ToolStatus | null = null

/**
 * Detects the installed tools. A complete result is cached; a partial one
 * is re-checked on the next call so installing a tool does not require a
 * server restart.
 */
export async function detectTools(): Promise<ToolStatus> {
  if (detected?.qpdf && detected.gs) return detected

  const [qpdf, gs] = await Promise.all([
    readVersion(binaries.qpdf, ['--version']),
    readVersion(binaries.gs, ['--version']),
  ])
  detected = { qpdf, gs }
  return detected
}

async function readVersion(command: string, args: string[]) {
  try {
    const result = await run(command, args, { timeoutMs: 5000 })
    return result.code === 0 ? result.stdout.split('\n')[0].trim() : null
  } catch {
    return null
  }
}
