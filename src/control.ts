import net from 'node:net'

export interface ControlReply {
  id: number | null
  ok: boolean
  result?: unknown
  error?: string
}

export interface ControlClientOptions {
  host: string
  port: number
  timeoutMs: number
  maxLineBytes: number
}

interface Pending {
  method: string
  resolve: (reply: ControlReply) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  sent: boolean
}

/**
 * A failure that happened before the request reached the app (the connection broke while
 * writing). Such a request was never applied, so it may safely be sent again on a fresh
 * connection — unlike a lost reply, which is never replayed.
 */
export class NotSentError extends Error {}

/**
 * Client for the FigCraft control channel: newline-delimited JSON over a loopback TCP socket.
 *
 * Protocol (docs/control-protocol.md of the upstream project):
 *   request  {"id": 1, "method": "engine.execute", "params": {...}}
 *   reply    {"id": 1, "ok": true, "result": ...}
 *            {"id": 1, "ok": false, "error": "message"}
 *
 * A request is never replayed once it has been written: the app may have applied it before the
 * reply was lost. A connection the app closed while idle is replaced before the next request.
 */
export class ControlClient {
  private socket: net.Socket | null = null
  private buffer = ''
  private nextId = 1
  private closed = false
  private readonly pending = new Map<number, Pending>()
  private readonly endedSockets = new WeakSet<net.Socket>()

  constructor(private readonly options: ControlClientOptions) {}

  get address(): string {
    return `${this.options.host}:${this.options.port}`
  }

  /** Send one control method and return its `result`. Throws when the app reports an error. */
  async call(method: string, params: unknown = {}): Promise<unknown> {
    const reply = await this.request(method, params)
    if (!reply.ok) {
      throw new Error(reply.error ?? `the FigCraft app reported an error for "${method}"`)
    }
    return reply.result
  }

  /** Connect once, so a misconfigured port fails fast instead of on the first tool call. */
  async ping(): Promise<void> {
    await this.request('window.list', {})
  }

  async close(): Promise<void> {
    this.closed = true
    this.rejectAll(new Error('the bridge closed the control connection'))
    this.socket?.destroy()
    this.socket = null
  }

  private async request(method: string, params: unknown): Promise<ControlReply> {
    if (this.closed) throw new Error('the FigCraft control client is closed')
    try {
      return await this.sendOnce(method, params)
    } catch (error) {
      if (!(error instanceof NotSentError)) throw error
      // The request never reached the app: replace the broken connection and send it once more.
      this.socket?.destroy()
      this.socket = null
      return this.sendOnce(method, params)
    }
  }

  private async sendOnce(method: string, params: unknown): Promise<ControlReply> {
    const socket = await this.connect()
    const id = this.nextId++
    const line = `${JSON.stringify({ id, method, params })}\n`

    return new Promise<ControlReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new Error(
            `the FigCraft app did not answer "${method}" within ${this.options.timeoutMs}ms (its own limit is 60s)`,
          ),
        )
      }, this.options.timeoutMs)

      this.pending.set(id, { method, resolve, reject, timer, sent: false })

      socket.write(line, (error) => {
        const entry = this.pending.get(id)
        if (!entry) return
        if (error) {
          this.pending.delete(id)
          clearTimeout(entry.timer)
          entry.reject(new NotSentError(`the request was not sent: ${error.message}`))
          return
        }
        entry.sent = true
      })
    })
  }

  private connect(): Promise<net.Socket> {
    if (this.isUsable(this.socket)) {
      return Promise.resolve(this.socket as net.Socket)
    }
    this.socket?.destroy()
    this.socket = null

    return new Promise<net.Socket>((resolve, reject) => {
      const socket = net.createConnection({ host: this.options.host, port: this.options.port })
      const onError = (error: Error): void => {
        socket.destroy()
        this.socket = null
        reject(
          new Error(
            `cannot reach the FigCraft app at ${this.address}: ${error.message}. ` +
              'Start it with the control channel (tools/FigCraftControl.app or scripts/figcraft-control.sh).',
          ),
        )
      }
      socket.once('error', onError)
      socket.once('connect', () => {
        socket.off('error', onError)
        this.attach(socket)
        resolve(socket)
      })
    })
  }

  /**
   * A connection is usable while it is open, the peer has not closed it and nothing
   * unexpected is waiting to be read. The app drops connections that sat idle past
   * its socket timeout, so this is checked before every request — replacing a dead
   * connection never repeats a request.
   */
  private isUsable(socket: net.Socket | null): boolean {
    if (!socket) return false
    if (socket.destroyed || !socket.writable) return false
    if (socket.readableEnded || socket.writableEnded) return false
    if (this.endedSockets.has(socket)) return false
    if (socket.readableLength > 0) return false
    return true
  }

  private attach(socket: net.Socket): void {
    this.socket = socket
    this.buffer = ''

    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => this.onData(chunk))
    socket.on('end', () => {
      this.endedSockets.add(socket)
    })
    socket.on('error', (error: Error) => {
      this.failAll(error.message, 'the request may have been applied')
      this.socket = null
    })
    socket.on('close', () => {
      this.endedSockets.add(socket)
      this.failAll('the FigCraft app closed the control connection', 'the request may have been applied')
      this.socket = null
    })
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    if (this.buffer.length > this.options.maxLineBytes) {
      this.buffer = ''
      this.failAll('the control reply exceeded the frame limit', 'the request may have been applied')
      this.socket?.destroy()
      this.socket = null
      return
    }

    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line !== '') this.onLine(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  private onLine(line: string): void {
    let reply: ControlReply
    try {
      reply = JSON.parse(line) as ControlReply
    } catch {
      this.failAll('the FigCraft app sent a reply that is not JSON', 'the request may have been applied')
      return
    }
    const id = reply.id
    if (id === null || id === undefined) {
      this.failAll(reply.error ?? 'the FigCraft app sent a reply without an id', 'the request may have been applied')
      return
    }
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    clearTimeout(entry.timer)
    entry.resolve(reply)
  }

  private failAll(reason: string, hint: string): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      if (!entry.sent) {
        entry.reject(new NotSentError(`${reason} before "${entry.method}" was sent.`))
      } else {
        entry.reject(
          new Error(
            `${reason} while running "${entry.method}": ${hint}; inspect the document before retrying.`,
          ),
        )
      }
    }
    this.pending.clear()
  }

  private rejectAll(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }
}
