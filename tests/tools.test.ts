import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import net from 'node:net'
import { describe, expect, it } from 'vitest'

import { loadConfig } from '../src/config.js'
import { ControlClient } from '../src/control.js'
import { createServer } from '../src/server.js'

const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const DOCUMENT = {
  name: 'Untitled',
  path: null,
  dirty: false,
  currentPage: 1,
  selection: [2],
  variables: [{ id: 'v1', name: 'color/bg', resolvedType: 'COLOR' }],
  styles: [{ id: 's1', name: 'Fill/Primary', type: 'FILL' }],
  pages: [
    {
      id: 1,
      name: 'Page 1',
      type: 'PAGE',
      children: [
        {
          id: 2,
          name: 'Card',
          type: 'FRAME',
          children: [{ id: 3, name: 'Title', type: 'TEXT' }],
        },
      ],
    },
  ],
}

const NODE = {
  id: 2,
  name: 'Card',
  type: 'FRAME',
  x: 40,
  y: 40,
  width: 320,
  height: 180,
  fills: [{ type: 'solid', color: '#FFFFFF' }],
  cornerRadius: 16,
  layout: { mode: 'vertical', gap: 12, padding: 24 },
  children: [{ id: 3, name: 'Title', type: 'TEXT', characters: 'Hi' }],
}

async function startFakeApp(): Promise<{ port: number; close: () => Promise<void> }> {
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

        const request = JSON.parse(line) as { id: number; method: string; params: Record<string, unknown> }
        let result: unknown = {}
        switch (request.method) {
          case 'engine.commands':
            result = [
              { id: 'node.create', label: 'Create layer', menu: '', shortcut: '', params: '{type}', undoable: true },
              { id: 'align.left', label: 'Align left', menu: 'Align', shortcut: 'A', params: '{ids}', undoable: true },
            ]
            break
          case 'engine.execute': {
            const command = request.params.command
            if (command === 'node.create') result = { id: 9 }
            else if (command === 'inspect.properties') result = { sections: [{ title: 'Layout', rows: [] }] }
            else if (command === 'inspect.code') result = { code: '.card { width: 320px }', language: 'css', connected: false }
            else result = { command }
            break
          }
          case 'document.inspect':
            result = DOCUMENT
            break
          case 'node.get':
            result = request.params.id === NODE.id ? NODE : null
            break
          case 'ui.render':
          case 'ui.screenshot':
            result = { data: TINY_PNG, format: 'png', width: 1, height: 1 }
            break
          case 'ui.inspect':
            result = { tool: 'move', windows: [{ id: 0 }] }
            break
          default:
            result = {}
        }
        socket.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`)
      }
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the fake app has no port')
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function connectClient(port: number): Promise<{ client: Client; control: ControlClient; close: () => Promise<void> }> {
  const config = loadConfig({ FIGCRAFT_CONTROL_PORT: String(port) } as NodeJS.ProcessEnv)
  const control = new ControlClient({
    host: config.host,
    port: config.port,
    timeoutMs: config.requestTimeoutMs,
    maxLineBytes: config.maxLineBytes,
  })
  const server = createServer({ control, config })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

  return {
    client,
    control,
    close: async () => {
      await client.close()
      await control.close()
    },
  }
}

describe('figcraft-app-mcp', () => {
  it('lists the FigCraft-native and the Figma-compatible tools', async () => {
    const app = await startFakeApp()
    const { client, close } = await connectClient(app.port)

    const tools = await client.listTools()
    const names = tools.tools.map((tool) => tool.name)
    expect(names).toContain('run_command')
    expect(names).toContain('create_node')
    expect(names).toContain('inspect_document')
    expect(names).toContain('get_metadata')
    expect(names).toContain('get_design_context')
    expect(names).toContain('get_screenshot')
    expect(names).toContain('get_code_connect_map')
    expect(names).toContain('get_variable_defs')

    await close()
    await app.close()
  })

  it('answers get_metadata in the Figma shape', async () => {
    const app = await startFakeApp()
    const { client, close } = await connectClient(app.port)

    const result = await client.callTool({ name: 'get_metadata', arguments: {} })
    const payload = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text) as {
      id: number
      name: string
      type: string
      children: Array<{ id: number; name: string; type: string }>
    }
    expect(payload.type).toBe('CANVAS')
    expect(payload.children[0]).toMatchObject({ id: 2, name: 'Card', type: 'FRAME' })

    await close()
    await app.close()
  })

  it('answers get_design_context with the layer properties', async () => {
    const app = await startFakeApp()
    const { client, close } = await connectClient(app.port)

    const result = await client.callTool({
      name: 'get_design_context',
      arguments: { nodeId: 2, includeCode: true },
    })
    const payload = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text) as {
      node: Record<string, unknown>
      code: { language: string }
    }
    expect(payload.node.width).toBe(320)
    expect(payload.node.fills).toEqual([{ type: 'solid', color: '#FFFFFF' }])
    expect(payload.code.language).toBe('css')

    await close()
    await app.close()
  })

  it('returns image content for get_screenshot', async () => {
    const app = await startFakeApp()
    const { client, close } = await connectClient(app.port)

    const result = await client.callTool({ name: 'get_screenshot', arguments: { nodeId: 2 } })
    const content = result.content as Array<{ type: string; mimeType?: string; data?: string }>
    const image = content.find((block) => block.type === 'image')
    expect(image?.mimeType).toBe('image/png')
    expect(image?.data).toBe(TINY_PNG)

    await close()
    await app.close()
  })

  it('passes a command through to the app', async () => {
    const app = await startFakeApp()
    const { client, close } = await connectClient(app.port)

    const result = await client.callTool({
      name: 'run_command',
      arguments: { command: 'align.left', params: { ids: [2] } },
    })
    const payload = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text) as {
      command: string
    }
    expect(payload.command).toBe('align.left')

    await close()
    await app.close()
  })

  it('reports an app error as a tool error, not a crash', async () => {
    const app = await startFakeApp()
    const { client, close } = await connectClient(app.port)

    const result = await client.callTool({ name: 'get_node', arguments: { id: 999999 } })
    expect(result.isError).toBe(true)

    await close()
    await app.close()
  })
})
