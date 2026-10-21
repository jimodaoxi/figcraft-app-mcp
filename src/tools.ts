import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { assertPathAllowed, type FigCraftConfig } from './config.js'
import { ControlClient } from './control.js'
import { buildDesignContext, buildMetadataTree, toFigmaType } from './figma.js'

export interface ToolDeps {
  control: ControlClient
  config: FigCraftConfig
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}

const MUTATING = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
}

const NODE_ID = z.number().int().nonnegative()
const IDS = z.array(NODE_ID).optional()
const PROPS = z.record(z.string(), z.unknown())

// ---------- results ----------

export function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] }
}

export function jsonResult(value: unknown): CallToolResult {
  return textResult(JSON.stringify(value, null, 2))
}

export function imageResult(bytes: Buffer, mimeType: string, info: unknown): CallToolResult {
  return {
    content: [
      { type: 'image', data: bytes.toString('base64'), mimeType },
      { type: 'text', text: JSON.stringify(info, null, 2) },
    ],
  }
}

function errorResult(operation: string, error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error)
  return {
    content: [{ type: 'text', text: `figcraft-mcp failed during "${operation}": ${message}` }],
    isError: true,
  }
}

async function safely(
  operation: string,
  action: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await action()
  } catch (error) {
    return errorResult(operation, error)
  }
}

// ---------- control helpers ----------

async function execCommand(
  control: ControlClient,
  command: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  return control.call('engine.execute', { command, params })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The app answers exports and renders with `{"data": "<base64>"}`. */
function decodeData(value: unknown): Buffer {
  if (!isRecord(value)) throw new Error('the app returned no data')
  const data = value.data
  if (typeof data !== 'string') throw new Error('the app returned no data')
  const payload = data.includes(',') ? (data.split(',')[1] ?? data) : data
  return Buffer.from(payload.trim(), 'base64')
}

/** PNG dimensions from the IHDR chunk. */
function pngSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24) return null
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (!bytes.subarray(0, 8).equals(signature)) return null
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

async function pageChildren(control: ControlClient): Promise<number[]> {
  const doc = await control.call('document.inspect', { depth: 1 })
  if (!isRecord(doc)) return []
  const pages = Array.isArray(doc.pages) ? doc.pages : []
  const current = doc.currentPage
  const page =
    pages.find((entry) => isRecord(entry) && entry.id === current) ??
    pages.find((entry) => isRecord(entry))
  if (!isRecord(page) || !Array.isArray(page.children)) return []
  return page.children
    .map((child) => (isRecord(child) && typeof child.id === 'number' ? child.id : null))
    .filter((id): id is number => id !== null)
}

function currentPage(doc: unknown): Record<string, unknown> | null {
  if (!isRecord(doc)) return null
  const pages = Array.isArray(doc.pages) ? doc.pages : []
  const current = doc.currentPage
  const page =
    pages.find((entry) => isRecord(entry) && entry.id === current) ??
    pages.find((entry) => isRecord(entry))
  return isRecord(page) ? page : null
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

// ---------- tool registration ----------

export function registerTools(server: McpServer, deps: ToolDeps): void {
  const { control, config } = deps

  // ----- the FigCraft-native surface (same names as the upstream figcraft-mcp) -----

  server.registerTool(
    'list_commands',
    {
      title: 'List FigCraft commands',
      description:
        'Every command the FigCraft app can run (561 of them): id, label, menu, shortcut and parameter doc. Filter with `filter`.',
      inputSchema: z.object({ filter: z.string().min(1).optional() }),
      annotations: READ_ONLY,
    },
    async ({ filter }) =>
      safely('list_commands', async () => {
        const all = await control.call('engine.commands', {})
        const list = Array.isArray(all) ? all : []
        const needle = (filter ?? '').toLowerCase()
        const filtered = needle
          ? list.filter((entry) => {
              if (!isRecord(entry)) return false
              return ['id', 'label', 'menu', 'params'].some((key) => {
                const value = entry[key]
                return typeof value === 'string' && value.toLowerCase().includes(needle)
              })
            })
          : list
        if (filtered.length === 0) return textResult(`no command matches \`${filter}\``)
        const lines = [
          `${filtered.length} commands (id — label [menu] (shortcut) params; * = undoable):`,
        ]
        for (const entry of filtered) {
          if (!isRecord(entry)) continue
          const get = (key: string): string => (typeof entry[key] === 'string' ? (entry[key] as string) : '')
          lines.push(
            `${get('id')}${entry.undoable === true ? '*' : ''} — ${get('label')}` +
              `${get('menu') ? ` [${get('menu')}]` : ''}${get('shortcut') ? ` (${get('shortcut')})` : ''} ${get('params')}`,
          )
        }
        return textResult(lines.join('\n'))
      }),
  )

  server.registerTool(
    'run_command',
    {
      title: 'Run a FigCraft command',
      description:
        'Run any command of the app (the same ids as the menus, shortcuts and the Actions palette): align.left, layout.add, component.create, instance.place, inspect.code, file.export, …',
      inputSchema: z.object({
        command: z.string().min(1),
        params: z.record(z.string(), z.unknown()).optional(),
      }),
      annotations: MUTATING,
    },
    async ({ command, params }) =>
      safely('run_command', async () => jsonResult(await execCommand(control, command, params ?? {}))),
  )

  server.registerTool(
    'batch',
    {
      title: 'Run a batch of commands',
      description:
        'Several commands as one undo step (command.batch), all-or-nothing. A step may use what an earlier step returned: {"$step": n} anywhere in its params becomes the id of step n (zero-based).',
      inputSchema: z.object({
        commands: z
          .array(
            z.object({
              command: z.string().min(1),
              params: z.record(z.string(), z.unknown()).optional(),
            }),
          )
          .min(1),
        label: z.string().optional(),
      }),
      annotations: MUTATING,
    },
    async ({ commands, label }) =>
      safely('batch', async () => {
        const steps = commands.map((step) => ({
          command: step.command,
          params: step.params ?? {},
        }))
        return jsonResult(
          await execCommand(control, 'command.batch', {
            label: label ?? 'Batch',
            commands: steps,
          }),
        )
      }),
  )

  server.registerTool(
    'create_node',
    {
      title: 'Create a layer',
      description:
        'Create a frame, rectangle, ellipse, polygon, star, line, arrow, text, vector, section, component or slice. Coordinates are page units relative to the parent frame (the page when there is none).',
      inputSchema: z.object({
        type: z.string().min(1),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        parent: NODE_ID.optional(),
        index: z.number().int().optional(),
        name: z.string().optional(),
        text: z.string().optional(),
        path: z.string().optional(),
        points: z.array(z.array(z.number())).optional(),
        closed: z.boolean().optional(),
        props: PROPS.optional(),
      }),
      annotations: MUTATING,
    },
    async (args) =>
      safely('create_node', async () => {
        const params: Record<string, unknown> = { type: args.type }
        for (const key of [
          'x',
          'y',
          'width',
          'height',
          'parent',
          'index',
          'name',
          'text',
          'path',
          'points',
          'closed',
          'props',
        ] as const) {
          const value = args[key]
          if (value !== undefined) params[key] = value
        }
        const created = await execCommand(control, 'node.create', params)
        const id = isRecord(created) && typeof created.id === 'number' ? created.id : null
        if (id === null) throw new Error('node.create returned no id')
        const node = await control.call('node.get', { id, depth: 0 })
        return jsonResult({ id, node })
      }),
  )

  server.registerTool(
    'set_properties',
    {
      title: 'Set layer properties',
      description:
        'Change layers: geometry, fills, strokes, effects, corner radius, auto layout, sizing, constraints, masks, handoff status, text props. Acts on `ids`, or on the selection when none are given.',
      inputSchema: z.object({ ids: IDS, props: PROPS }),
      annotations: MUTATING,
    },
    async ({ ids, props }) =>
      safely('set_properties', async () => {
        if (!isRecord(props) || Object.keys(props).length === 0) {
          throw new Error('`props` must be a non-empty object')
        }
        const params: Record<string, unknown> = { props }
        if (ids && ids.length > 0) params.ids = ids
        const result = await execCommand(control, 'node.set', params)
        let targets = ids
        if (!targets || targets.length === 0) {
          const doc = await control.call('document.inspect', { depth: 0 })
          targets = isRecord(doc) && Array.isArray(doc.selection)
            ? doc.selection.filter((id): id is number => typeof id === 'number')
            : []
        }
        const nodes = []
        for (const id of targets.slice(0, 20)) {
          const node = await control.call('node.get', { id, depth: 0 })
          if (node !== null) nodes.push(node)
        }
        const warnings = isRecord(result) ? result.warnings : undefined
        return jsonResult({ ok: true, nodes, ...(warnings === undefined ? {} : { warnings }) })
      }),
  )

  server.registerTool(
    'inspect_document',
    {
      title: 'Inspect the document',
      description:
        'The document as JSON: name, path, dirty flag, current page, selection, the layer tree, styles, variables, images, colour profile, the text being edited and the undo history.',
      inputSchema: z.object({
        depth: z.number().int().min(0).max(64).optional(),
        allPages: z.boolean().optional(),
      }),
      annotations: READ_ONLY,
    },
    async ({ depth, allPages }) =>
      safely('inspect_document', async () =>
        jsonResult(
          await control.call('document.inspect', {
            depth: depth ?? 4,
            allPages: allPages ?? false,
          }),
        ),
      ),
  )

  server.registerTool(
    'get_node',
    {
      title: 'Read one layer',
      description:
        'One layer as JSON: id, name, type, geometry, fills, strokes, effects, auto layout, sizing, constraints, text properties, component links, overrides, interactions, exports, dev status and annotations.',
      inputSchema: z.object({ id: NODE_ID, depth: z.number().int().min(0).max(64).optional() }),
      annotations: READ_ONLY,
    },
    async ({ id, depth }) =>
      safely('get_node', async () => {
        const node = await control.call('node.get', { id, depth: depth ?? 1 })
        if (node === null) throw new Error(`no such layer ${id}`)
        return jsonResult(node)
      }),
  )

  server.registerTool(
    'select',
    {
      title: 'Change the selection',
      description: 'Replace the selection with the given layer ids (an empty array deselects).',
      inputSchema: z.object({ ids: z.array(NODE_ID) }),
      annotations: MUTATING,
    },
    async ({ ids }) =>
      safely('select', async () => {
        if (ids.length === 0) await execCommand(control, 'select.none', {})
        else await execCommand(control, 'select.set', { ids })
        const doc = await control.call('document.inspect', { depth: 0 })
        const selection = isRecord(doc) ? doc.selection : null
        return jsonResult({ selection })
      }),
  )

  server.registerTool(
    'export',
    {
      title: 'Export layers',
      description:
        'Export layers as png, jpg, svg, webp, pdf or fig. Without `path` the bytes come back as image content; with `path` the app writes the file.',
      inputSchema: z.object({
        ids: IDS,
        format: z.enum(['png', 'jpg', 'jpeg', 'svg', 'webp', 'pdf', 'fig']).optional(),
        scale: z.number().positive().optional(),
        size: z.string().optional(),
        path: z.string().min(1).optional(),
        bleed: z.union([z.number(), z.string()]).optional(),
        cropMarks: z.boolean().optional(),
        bleedMarks: z.boolean().optional(),
        cmyk: z.boolean().optional(),
        contentsOnly: z.boolean().optional(),
        includeBoundingBox: z.boolean().optional(),
        svgOutlineText: z.boolean().optional(),
        svgIdAttribute: z.boolean().optional(),
        svgSimplifyStroke: z.boolean().optional(),
      }),
      annotations: MUTATING,
    },
    async (args) =>
      safely('export', async () => {
        const params: Record<string, unknown> = {}
        if (args.ids && args.ids.length > 0) params.ids = args.ids
        if (args.format) params.format = args.format
        if (args.scale !== undefined) params.scale = args.scale
        for (const key of [
          'size',
          'bleed',
          'cropMarks',
          'bleedMarks',
          'cmyk',
          'contentsOnly',
          'includeBoundingBox',
          'svgOutlineText',
          'svgIdAttribute',
          'svgSimplifyStroke',
        ] as const) {
          const value = args[key]
          if (value !== undefined) params[key] = value
        }
        if (args.path) {
          assertPathAllowed(args.path, config.allowedWriteRoots, 'write')
          params.path = args.path
          return jsonResult(await execCommand(control, 'file.export', params))
        }
        const result = await execCommand(control, 'file.export', params)
        const format = isRecord(result) && typeof result.format === 'string' ? result.format : 'png'
        const bytes = decodeData(result)
        if (format === 'svg') return textResult(bytes.toString('utf8'))
        const mime = format === 'jpg' || format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png'
        return imageResult(bytes, mime, { format, bytes: bytes.length, ...(pngSize(bytes) ?? {}) })
      }),
  )

  server.registerTool(
    'screenshot',
    {
      title: 'Screenshot the canvas or the app window',
      description:
        'PNG of the page (with background) or of the given layers, scaled to fit `maxSize` (default 1600). `window: true` captures the app window, a window id that window.',
      inputSchema: z.object({
        ids: IDS,
        scale: z.number().positive().optional(),
        maxSize: z.number().int().min(16).max(8192).optional(),
        window: z.union([z.boolean(), NODE_ID]).optional(),
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      safely('screenshot', async () => {
        if (args.window !== undefined && args.window !== false) {
          const params = typeof args.window === 'number' ? { window: args.window } : {}
          const bytes = decodeData(await control.call('ui.screenshot', params))
          return imageResult(bytes, 'image/png', { source: 'window', ...(pngSize(bytes) ?? {}) })
        }
        const maxSize = clamp(args.maxSize ?? 1600, 16, 8192)
        let scale = args.scale ?? 1
        const ids = args.ids ?? []
        const measured = ids.length > 0 ? ids : await pageChildren(control)
        if (measured.length === 0) throw new Error('the current page is empty: nothing to render')
        let bytes = decodeData(await control.call('ui.render', { ids: measured, scale }))
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const size = pngSize(bytes)
          if (!size) break
          const side = Math.max(size.width, size.height)
          if (side <= maxSize) break
          scale *= maxSize / side
          bytes = decodeData(await control.call('ui.render', { ids: measured, scale }))
        }
        return imageResult(bytes, 'image/png', {
          source: ids.length > 0 ? 'layers' : 'page',
          ids,
          scale,
          ...(pngSize(bytes) ?? {}),
        })
      }),
  )

  server.registerTool(
    'open_file',
    {
      title: 'Open a file',
      description:
        'Open a .figcraft, .json (FigCraft or REST API file JSON), .fig, .svg or image file in the app. Returns the file summary and the document outline.',
      inputSchema: z.object({
        path: z.string().min(1),
        variables: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
      }),
      annotations: MUTATING,
    },
    async ({ path, variables }) =>
      safely('open_file', async () => {
        assertPathAllowed(path, config.allowedReadRoots, 'read')
        const params: Record<string, unknown> = { path }
        if (variables !== undefined) params.variables = variables
        return jsonResult(await execCommand(control, 'file.open', params))
      }),
  )

  server.registerTool(
    'save_file',
    {
      title: 'Save the document',
      description: 'Save the document; `path` is needed the first time a document is saved programmatically.',
      inputSchema: z.object({ path: z.string().min(1).optional() }),
      annotations: MUTATING,
    },
    async ({ path }) =>
      safely('save_file', async () => {
        const params: Record<string, unknown> = {}
        if (path) {
          assertPathAllowed(path, config.allowedWriteRoots, 'write')
          params.path = path
        }
        return jsonResult(await execCommand(control, 'file.save', params))
      }),
  )

  server.registerTool(
    'undo',
    {
      title: 'Undo',
      description: 'Undo the last change (one command, batch or gesture).',
      inputSchema: z.object({}),
      annotations: MUTATING,
    },
    async () => safely('undo', async () => jsonResult(await execCommand(control, 'edit.undo', {}))),
  )

  server.registerTool(
    'redo',
    {
      title: 'Redo',
      description: 'Redo the last undone change.',
      inputSchema: z.object({}),
      annotations: MUTATING,
    },
    async () => safely('redo', async () => jsonResult(await execCommand(control, 'edit.redo', {}))),
  )

  server.registerTool(
    'pointer',
    {
      title: 'Pointer gesture',
      description:
        'A mouse gesture with the current tool: click, double, drag, down, move, up, hover. Positions are page coordinates; `to` is the drag target.',
      inputSchema: z.object({
        kind: z.enum(['click', 'double', 'drag', 'down', 'move', 'up', 'hover']).optional(),
        x: z.number(),
        y: z.number(),
        to: z.tuple([z.number(), z.number()]).optional(),
        steps: z.number().int().min(1).max(200).optional(),
        tool: z.string().min(1).optional(),
        shift: z.boolean().optional(),
        alt: z.boolean().optional(),
        cmd: z.boolean().optional(),
        pressure: z.number().min(0).max(1).optional(),
        pressureTo: z.number().min(0).max(1).optional(),
      }),
      annotations: MUTATING,
    },
    async (args) =>
      safely('pointer', async () => {
        if (args.tool) await execCommand(control, 'tool.set', { tool: args.tool })
        const params: Record<string, unknown> = {
          kind: args.kind ?? 'click',
          x: args.x,
          y: args.y,
        }
        if (args.to) params.to = args.to
        if (args.steps !== undefined) params.steps = args.steps
        if (args.pressure !== undefined) params.pressure = args.pressure
        if (args.pressureTo !== undefined) params.pressureTo = args.pressureTo
        for (const key of ['shift', 'alt', 'cmd'] as const) {
          if (args[key] !== undefined) params[key] = args[key]
        }
        return jsonResult(await control.call('ui.pointer', params))
      }),
  )

  server.registerTool(
    'key',
    {
      title: 'Press a key',
      description:
        'A shortcut or key as if typed on the canvas: "A", "0", "Enter", "ArrowLeft", "=", or egui names like "Plus". `cmd` is Cmd on macOS.',
      inputSchema: z.object({
        key: z.string().min(1),
        shift: z.boolean().optional(),
        alt: z.boolean().optional(),
        cmd: z.boolean().optional(),
        ctrl: z.boolean().optional(),
      }),
      annotations: MUTATING,
    },
    async (args) =>
      safely('key', async () => {
        const params: Record<string, unknown> = { key: args.key }
        for (const key of ['shift', 'alt', 'cmd', 'ctrl'] as const) {
          if (args[key] !== undefined) params[key] = args[key]
        }
        return jsonResult(await control.call('ui.key', params))
      }),
  )

  server.registerTool(
    'type_text',
    {
      title: 'Type text',
      description:
        'Type into the text being edited, or replace the contents of the text layer `id` (the text is edited and the edit ended again).',
      inputSchema: z.object({ text: z.string(), id: NODE_ID.optional() }),
      annotations: MUTATING,
    },
    async ({ text, id }) =>
      safely('type_text', async () => {
        if (id === undefined) return jsonResult(await control.call('ui.type', { text }))
        await execCommand(control, 'text.edit.begin', { id })
        let typed: unknown
        try {
          typed = await control.call('ui.type', { text })
        } finally {
          await execCommand(control, 'text.edit.end', {})
        }
        const node = await control.call('node.get', { id, depth: 0 })
        return jsonResult({ ok: true, node, typed })
      }),
  )

  server.registerTool(
    'inspect_ui',
    {
      title: 'Inspect the app UI',
      description:
        'The app state: panels, current tool, view, zoom, timings, frames drawn, the windows the app has, the live session and the home screen.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () => safely('inspect_ui', async () => jsonResult(await control.call('ui.inspect', {}))),
  )

  // ----- the Figma-compatible surface (same names as the Figma desktop MCP) -----

  server.registerTool(
    'get_metadata',
    {
      title: 'Get metadata (Figma compatible)',
      description:
        'The layer hierarchy in the Figma MCP shape: {id, name, type, children}. Without `nodeId` the current page is returned.',
      inputSchema: z.object({
        nodeId: NODE_ID.optional(),
        depth: z.number().int().min(0).max(64).optional(),
      }),
      annotations: READ_ONLY,
    },
    async ({ nodeId, depth }) =>
      safely('get_metadata', async () => {
        const treeDepth = depth ?? 8
        let source: unknown
        if (nodeId !== undefined) {
          source = await control.call('node.get', { id: nodeId, depth: treeDepth })
          if (source === null) throw new Error(`no such layer ${nodeId}`)
        } else {
          const doc = await control.call('document.inspect', { depth: treeDepth })
          const page = currentPage(doc)
          if (!page) throw new Error('the app has no open document')
          source = page
        }
        const tree = buildMetadataTree(source, treeDepth)
        if (!tree) throw new Error('nothing to describe')
        return jsonResult(tree)
      }),
  )

  server.registerTool(
    'get_design_context',
    {
      title: 'Get design context (Figma compatible)',
      description:
        'The design context of a layer: geometry, auto layout, sizing, fills, strokes, effects, typography, styles, variables, component links and interactions — the facts a code generator needs.',
      inputSchema: z.object({
        nodeId: NODE_ID.optional(),
        depth: z.number().int().min(0).max(64).optional(),
        includeProperties: z.boolean().optional(),
        includeCode: z.boolean().optional(),
        language: z.enum(['css', 'html', 'react', 'leptos', 'swiftui', 'compose']).optional(),
      }),
      annotations: READ_ONLY,
    },
    async ({ nodeId, depth, includeProperties, includeCode, language }) =>
      safely('get_design_context', async () => {
        const treeDepth = depth ?? 2
        let node: unknown
        if (nodeId !== undefined) {
          node = await control.call('node.get', { id: nodeId, depth: treeDepth })
          if (node === null) throw new Error(`no such layer ${nodeId}`)
        } else {
          const doc = await control.call('document.inspect', { depth: treeDepth })
          const page = currentPage(doc)
          if (!page) throw new Error('the app has no open document')
          node = page
        }
        const context = buildDesignContext(node)
        const out: Record<string, unknown> = { node: context }

        if (includeProperties !== false && nodeId !== undefined) {
          const properties = await execCommand(control, 'inspect.properties', { id: nodeId })
          if (properties !== null) out.properties = properties
        }
        if (includeCode && nodeId !== undefined) {
          const params: Record<string, unknown> = { id: nodeId }
          if (language) params.language = language
          const code = await execCommand(control, 'inspect.code', params)
          if (code !== null) out.code = code
        }
        return jsonResult(out)
      }),
  )

  server.registerTool(
    'get_screenshot',
    {
      title: 'Get a screenshot (Figma compatible)',
      description:
        'PNG of a layer (or of the current page) in the Figma MCP shape: `nodeId` for one layer, `window: true` for what the app window shows.',
      inputSchema: z.object({
        nodeId: NODE_ID.optional(),
        ids: IDS,
        scale: z.number().positive().optional(),
        maxSize: z.number().int().min(16).max(8192).optional(),
        window: z.boolean().optional(),
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      safely('get_screenshot', async () => {
        if (args.window) {
          const bytes = decodeData(await control.call('ui.screenshot', {}))
          return imageResult(bytes, 'image/png', { source: 'window', ...(pngSize(bytes) ?? {}) })
        }
        const ids = args.ids ?? (args.nodeId !== undefined ? [args.nodeId] : [])
        const maxSize = clamp(args.maxSize ?? 1600, 16, 8192)
        let scale = args.scale ?? 1
        const measured = ids.length > 0 ? ids : await pageChildren(control)
        if (measured.length === 0) throw new Error('the current page is empty: nothing to render')
        let bytes = decodeData(await control.call('ui.render', { ids: measured, scale }))
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const size = pngSize(bytes)
          if (!size) break
          const side = Math.max(size.width, size.height)
          if (side <= maxSize) break
          scale *= maxSize / side
          bytes = decodeData(await control.call('ui.render', { ids: measured, scale }))
        }
        return imageResult(bytes, 'image/png', {
          source: ids.length > 0 ? 'layers' : 'page',
          ids,
          scale,
          ...(pngSize(bytes) ?? {}),
        })
      }),
  )

  server.registerTool(
    'get_code_connect_map',
    {
      title: 'Get the code connect map (Figma compatible)',
      description:
        'The code connect links of the document: every component that is connected to real code, with its language, import path, name and template.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () =>
      safely('get_code_connect_map', async () => {
        const doc = await control.call('document.inspect', { depth: 32, allPages: true })
        const components: number[] = []
        const walk = (nodes: unknown): void => {
          if (!Array.isArray(nodes)) return
          for (const node of nodes) {
            if (!isRecord(node)) continue
            if (typeof node.id === 'number' && toFigmaType(node.type) === 'COMPONENT') {
              components.push(node.id)
            }
            walk(node.children)
          }
        }
        if (isRecord(doc)) {
          const pages = Array.isArray(doc.pages) ? doc.pages : []
          for (const page of pages) {
            if (isRecord(page)) walk(page.children)
          }
        }
        const links: unknown[] = []
        for (const id of components.slice(0, 100)) {
          const node = await control.call('node.get', { id, depth: 0 })
          if (isRecord(node) && Array.isArray(node.codeLinks)) {
            links.push({ id, name: node.name, codeLinks: node.codeLinks })
          }
        }
        return jsonResult({ links })
      }),
  )

  server.registerTool(
    'get_variable_defs',
    {
      title: 'Get variable definitions (Figma compatible)',
      description:
        'The variables and paint styles of the document with their modes, code names and scopes — the Figma MCP shape.',
      inputSchema: z.object({ includeStyles: z.boolean().optional() }),
      annotations: READ_ONLY,
    },
    async ({ includeStyles }) =>
      safely('get_variable_defs', async () => {
        const doc = await control.call('document.inspect', { depth: 0 })
        const variables = isRecord(doc) ? doc.variables : undefined
        const styles = isRecord(doc) ? doc.styles : undefined
        const out: Record<string, unknown> = {
          variables: variables ?? [],
        }
        if (includeStyles !== false) out.styles = styles ?? []
        return jsonResult(out)
      }),
  )

  server.registerTool(
    'get_code',
    {
      title: 'Get code for a layer',
      description:
        'The code the app generates for a layer: CSS, HTML+CSS, React, Leptos, SwiftUI or Jetpack Compose (a whole layer tree for html/react/leptos).',
      inputSchema: z.object({
        nodeId: NODE_ID.optional(),
        language: z.enum(['css', 'html', 'react', 'leptos', 'swiftui', 'compose']).optional(),
        unit: z.enum(['px', 'rem']).optional(),
        rootFontSize: z.number().positive().optional(),
      }),
      annotations: READ_ONLY,
    },
    async ({ nodeId, language, unit, rootFontSize }) =>
      safely('get_code', async () => {
        const params: Record<string, unknown> = {}
        if (nodeId !== undefined) params.id = nodeId
        if (language) params.language = language
        if (unit) params.unit = unit
        if (rootFontSize !== undefined) params.rootFontSize = rootFontSize
        return jsonResult(await execCommand(control, 'inspect.code', params))
      }),
  )
}
