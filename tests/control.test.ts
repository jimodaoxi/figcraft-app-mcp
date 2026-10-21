import { describe, expect, it } from 'vitest'
import net from 'node:net'

import { ControlClient } from '../src/control.js'

interface FakeServerOptions {
  /** Answers a request; return the `result` to send back. */
  onRequest: (method: string, params: unknown) => unknown | { error: string }
  /** Close the connection after this many requests (0 = never). */
  closeAfter?: number
}

/** A stand-in for the FigCraft app's control channel. */
async function startFakeServer(options: FakeServerOptions): Promise<{ port: number; close: () => Promise<void> }> {
  let seen = 0
  const server = net.createServer((socket) => {
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (line.trim() === '') continue

        const request = JSON.parse(line) as { id: number; method: string; params: unknown }
        seen += 1
        const outcome = options.onRequest(request.method, request.params)
        const reply =
          outcome && typeof outcome === 'object' && 'error' in outcome
            ? { id: request.id, ok: false, error: (outcome as { error: string }).error }
            : { id: request.id, ok: true, result: outcome }
        if (!socket.writableEnded && !socket.destroyed) {
          socket.write(`${JSON.stringify(reply)}\n`)
        }

        if (options.closeAfter && seen >= options.closeAfter) socket.destroy()
      }
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the fake server has no port')

  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

describe('ControlClient', () => {
  it('sends a request line and resolves with the result', async () => {
    const fake = await startFakeServer({
      onRequest: (method, params) => ({ method, params }),
    })
    const client = new ControlClient({
      host: '127.0.0.1',
      port: fake.port,
      timeoutMs: 5_000,
      maxLineBytes: 1_048_576,
    })

    const result = await client.call('engine.execute', { command: 'file.save' })
    expect(result).toEqual({ method: 'engine.execute', params: { command: 'file.save' } })
    await client.close()
    await fake.close()
  })

  it('turns an error reply into a thrown error', async () => {
    const fake = await startFakeServer({
      onRequest: () => ({ error: 'the app says no' }),
    })
    const client = new ControlClient({
      host: '127.0.0.1',
      port: fake.port,
      timeoutMs: 5_000,
      maxLineBytes: 1_048_576,
    })

    await expect(client.call('engine.execute', {})).rejects.toThrow('the app says no')
    await client.close()
    await fake.close()
  })

  it('reconnects after the app closed an idle connection', async () => {
    const fake = await startFakeServer({
      onRequest: (method) => ({ ok: method }),
      closeAfter: 1,
    })
    const client = new ControlClient({
      host: '127.0.0.1',
      port: fake.port,
      timeoutMs: 5_000,
      maxLineBytes: 1_048_576,
    })

    expect(await client.call('first', {})).toEqual({ ok: 'first' })
    // The app drops connections that sat idle past its socket timeout: the close reaches the
    // client a moment later, and the next request then opens a new connection.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(await client.call('second', {})).toEqual({ ok: 'second' })
    await client.close()
    await fake.close()
  })

  it('reports a clear error when nothing listens on the port', async () => {
    const client = new ControlClient({
      host: '127.0.0.1',
      port: 1,
      timeoutMs: 5_000,
      maxLineBytes: 1_048_576,
    })

    await expect(client.call('window.list', {})).rejects.toThrow(/cannot reach the FigCraft app/)
    await client.close()
  })
})
