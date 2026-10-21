// Live check: drive the built MCP server against the running FigCraft app.
// Creates its own layer, exercises every tool family, then removes what it created.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const ROOT = new URL('..', import.meta.url).pathname
const PORT = process.env.FIGCRAFT_CONTROL_PORT ?? '7987'

const transport = new StdioClientTransport({
  command: 'node',
  args: [`${ROOT}dist/index.js`],
  env: { ...process.env, FIGCRAFT_CONTROL_PORT: PORT },
  stderr: 'pipe',
})

transport.stderr?.on('data', (chunk) => {
  const text = chunk.toString('utf8').trim()
  if (text) console.log(`[server] ${text}`)
})

const client = new Client({ name: 'live-check', version: '1.0.0' })
await client.connect(transport)

console.log('server:', JSON.stringify(client.getServerVersion()))
const { tools } = await client.listTools()
console.log(`tools (${tools.length}):`, tools.map((t) => t.name).join(', '))

const textOf = (result) =>
  (result.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')

let failures = 0
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args })
  const blocks = result.content ?? []
  const image = blocks.find((b) => b.type === 'image')
  const text = textOf(result)
  const failed = result.isError === true
  if (failed) failures += 1
  console.log(
    `${failed ? '✗' : '✓'} ${name}` +
      (image ? `  [${image.mimeType}, ${Math.round((image.data.length * 3) / 4 / 1024)} KiB]` : '') +
      `  ${text.replace(/\s+/g, ' ').slice(0, 110)}`,
  )
  return result
}

// --- Figma-compatible family -------------------------------------------------
await call('list_commands', { filter: 'align' })
await call('inspect_document', { depth: 2 })
await call('get_metadata')
await call('get_variable_defs')
await call('get_code_connect_map')

// --- create something to look at --------------------------------------------
const created = await call('create_node', {
  type: 'frame',
  name: 'LiveCheck',
  x: 40,
  y: 40,
  width: 320,
  height: 180,
  props: { fill: '#FFFFFF', cornerRadius: 16, layout: 'vertical', padding: 24, gap: 12 },
})
const id = JSON.parse(textOf(created)).id

await call('get_metadata')
await call('get_design_context', { nodeId: id, includeCode: true })
await call('get_screenshot', { nodeId: id })
await call('get_node', { id, depth: 1 })
await call('set_properties', { ids: [id], props: { fill: '#F5F5F5' } })
await call('batch', {
  label: 'live check',
  commands: [
    { command: 'node.create', params: { type: 'text', parent: id, text: 'Hello FigCraft', props: { fontSize: 24 } } },
  ],
})
await call('run_command', { command: 'align.left', params: { ids: [id] } })
await call('undo')
await call('inspect_ui')

// --- clean up what we created ------------------------------------------------
await call('run_command', { command: 'edit.delete', params: { ids: [id] } })

await client.close()
console.log(failures === 0 ? '\nlive check: all tools answered' : `\nlive check: ${failures} tool call(s) failed`)
process.exit(failures === 0 ? 0 : 1)
