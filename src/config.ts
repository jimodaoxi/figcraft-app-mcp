import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

export interface FigCraftConfig {
  /** Loopback host the FigCraft control channel listens on. */
  host: string
  /** Control port the app was started with (`figcraft --control <port>`). */
  port: number
  /** How long a single control request may take before the bridge gives up. */
  requestTimeoutMs: number
  /** Hard cap on a reply line, mirroring the app's own 32 MiB frame limit. */
  maxLineBytes: number
  /** Folders the agent may read from. Empty means "no restriction". */
  allowedReadRoots: string[]
  /** Folders the agent may write to. Empty means "no restriction". */
  allowedWriteRoots: string[]
  /** Largest image payload returned to the client (bytes). */
  maxImageBytes: number
}

export const DEFAULT_CONTROL_PORT = 7987

function boundedInteger(
  value: number,
  { minimum, maximum, name }: { minimum: number; maximum: number; name: string },
): number {
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`)
  return Math.min(maximum, Math.max(minimum, value))
}

function readRoots(raw: string | undefined, name: string): string[] {
  if (raw === undefined || raw.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${name} must contain valid JSON: ${message}`)
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error(`${name} must be a JSON array of absolute folder paths`)
  }
  return parsed.map((item) => {
    if (!isAbsolute(item)) throw new Error(`${name} entries must be absolute paths: ${item}`)
    const folder = resolve(item)
    if (!existsSync(folder)) throw new Error(`${name} folder does not exist: ${folder}`)
    return folder
  })
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): FigCraftConfig {
  const port = Number(env.FIGCRAFT_CONTROL_PORT ?? DEFAULT_CONTROL_PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('FIGCRAFT_CONTROL_PORT must be a port number between 1 and 65535')
  }

  return {
    host: (env.FIGCRAFT_CONTROL_HOST ?? '127.0.0.1').trim() || '127.0.0.1',
    port,
    requestTimeoutMs: boundedInteger(Number(env.FIGCRAFT_REQUEST_TIMEOUT_MS ?? 65_000), {
      minimum: 5_000,
      maximum: 600_000,
      name: 'FIGCRAFT_REQUEST_TIMEOUT_MS',
    }),
    maxLineBytes: boundedInteger(Number(env.FIGCRAFT_MAX_LINE_BYTES ?? 33_554_432), {
      minimum: 1_048_576,
      maximum: 134_217_728,
      name: 'FIGCRAFT_MAX_LINE_BYTES',
    }),
    allowedReadRoots: readRoots(env.FIGCRAFT_READ_ROOTS, 'FIGCRAFT_READ_ROOTS'),
    allowedWriteRoots: readRoots(env.FIGCRAFT_WRITE_ROOTS, 'FIGCRAFT_WRITE_ROOTS'),
    maxImageBytes: boundedInteger(Number(env.FIGCRAFT_MAX_IMAGE_BYTES ?? 25_000_000), {
      minimum: 100_000,
      maximum: 100_000_000,
      name: 'FIGCRAFT_MAX_IMAGE_BYTES',
    }),
  }
}

/**
 * True when `file` lives inside one of `roots` (whole path segments, so `/work2` is not inside `/work`).
 * With no roots the check passes: nothing is confined.
 */
export function isInsideRoots(file: string, roots: string[]): boolean {
  if (roots.length === 0) return true
  const target = resolve(file)
  return roots.some((root) => target === root || target.startsWith(`${root}/`))
}

export function assertPathAllowed(
  file: string,
  roots: string[],
  kind: 'read' | 'write',
): void {
  if (isInsideRoots(file, roots)) return
  const list = roots.join(', ')
  throw new Error(
    `automation path rejected: ${resolve(file)} is outside the folders that may be ${kind === 'read' ? 'read' : 'written'}: ${list}`,
  )
}
