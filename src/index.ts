#!/usr/bin/env node
import { loadConfig } from './config.js'
import { ControlClient } from './control.js'
import { createServer, serveStdio } from './server.js'

async function main(): Promise<void> {
  const config = loadConfig()
  const control = new ControlClient({
    host: config.host,
    port: config.port,
    timeoutMs: config.requestTimeoutMs,
    maxLineBytes: config.maxLineBytes,
  })
  const server = createServer({ control, config })

  let closing = false
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return
    closing = true
    process.stderr.write(`[figcraft-app-mcp] shutting down after ${signal}\n`)
    await server.close().catch(() => undefined)
    await control.close().catch(() => undefined)
  }

  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.stdin.once('close', () => void shutdown('stdin-close'))

  await serveStdio(server)
  process.stderr.write(`[figcraft-app-mcp] ready, control channel ${control.address}\n`)

  // The app may not be running yet; the tools report the connection error then.
  try {
    await control.ping()
    process.stderr.write(`[figcraft-app-mcp] connected to the FigCraft app at ${control.address}\n`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[figcraft-app-mcp] not connected yet: ${message}\n`)
  }
}

void main()
