// Clean up the probe layers left in the FigCraft document and show the final state.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const ROOT = new URL('..', import.meta.url).pathname

const transport = new StdioClientTransport({
  command: 'node',
  args: [`${ROOT}dist/index.js`],
  env: { ...process.env, FIGCRAFT_CONTROL_PORT: process.env.FIGCRAFT_CONTROL_PORT ?? '7987' },
  stderr: 'pipe',
})
transport.stderr?.on('data', (c) => {
  const t = c.toString('utf8').trim()
  if (t) console.log(`[server] ${t}`)
})

const client = new Client({ name: 'cleanup', version: '1.0.0' })
await client.connect(transport)

const textOf = (result) =>
  (result.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')

// what is on the page now?
const meta = await client.callTool({ name: 'get_metadata', arguments: {} })
const tree = JSON.parse(textOf(meta))
const ids = (tree.children ?? []).map((c) => c.id)
console.log('top-level layers before cleanup:', JSON.stringify(tree.children?.map((c) => ({ id: c.id, name: c.name }))))

if (ids.length > 0) {
  const del = await client.callTool({
    name: 'run_command',
    arguments: { command: 'edit.delete', params: { ids } },
  })
  console.log('delete ->', textOf(del).slice(0, 200))
}

// show the screenshot + design context output of the (now empty) document
const shot = await client.callTool({ name: 'get_screenshot', arguments: {} })
const image = (shot.content ?? []).find((b) => b.type === 'image')
console.log('screenshot content:', image ? `${image.mimeType} ${Math.round((image.data.length * 3) / 4 / 1024)} KiB` : 'none')
console.log('screenshot info:', textOf(shot).slice(0, 300))

const after = await client.callTool({ name: 'get_metadata', arguments: {} })
console.log('top-level layers after cleanup:', JSON.stringify(JSON.parse(textOf(after)).children ?? []))

await client.close()
