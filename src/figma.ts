/**
 * Mapping between FigCraft's document model and the shapes a Figma-MCP client expects.
 *
 * Figma's `get_metadata` answers with `{id, name, type, children}` per node, and its
 * `get_design_context` answers with the geometry, layout, paint and type properties a code
 * generator needs. FigCraft reports the same facts under different names, so this module
 * reshapes them without inventing anything.
 */

export interface FigmaNodeRef {
  id: number
  name: string
  type: string
  children?: FigmaNodeRef[]
}

const FIGMA_TYPES: Record<string, string> = {
  frame: 'FRAME',
  group: 'GROUP',
  section: 'SECTION',
  rectangle: 'RECTANGLE',
  ellipse: 'ELLIPSE',
  polygon: 'POLYGON',
  star: 'STAR',
  line: 'LINE',
  arrow: 'ARROW',
  vector: 'VECTOR',
  text: 'TEXT',
  component: 'COMPONENT',
  instance: 'INSTANCE',
  slice: 'SLICE',
  page: 'CANVAS',
  page_notice: 'CANVAS',
  boolean_group: 'BOOLEAN_GROUP',
}

export function toFigmaType(type: unknown): string {
  const raw = typeof type === 'string' ? type : ''
  const upper = raw.toUpperCase()
  if (upper === 'PAGE') return 'CANVAS'
  const mapped = FIGMA_TYPES[raw.toLowerCase()]
  if (mapped) return mapped
  return upper || 'UNKNOWN'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reshape one FigCraft layer (from `node.get`) into the Figma metadata shape. */
export function buildMetadataTree(node: unknown, depth: number): FigmaNodeRef | null {
  if (!isRecord(node)) return null
  const id = node.id
  if (typeof id !== 'number') return null

  const ref: FigmaNodeRef = {
    id,
    name: typeof node.name === 'string' ? node.name : '',
    type: toFigmaType(node.type),
  }
  if (depth > 0 && Array.isArray(node.children)) {
    const children = node.children
      .map((child) => buildMetadataTree(child, depth - 1))
      .filter((child): child is FigmaNodeRef => child !== null)
    if (children.length > 0) ref.children = children
  }
  return ref
}

const CONTEXT_KEYS = [
  'x',
  'y',
  'width',
  'height',
  'rotation',
  'absoluteBounds',
  'visible',
  'locked',
  'opacity',
  'blend',
  'cornerRadius',
  'clip',
  'fills',
  'strokes',
  'strokeWeight',
  'strokeAlign',
  'effects',
  'layout',
  'sizing',
  'minWidth',
  'maxWidth',
  'minHeight',
  'maxHeight',
  'absolute',
  'constraints',
  'gridCell',
  'characters',
  'fontFamily',
  'fontStyle',
  'fontSize',
  'fontVariations',
  'lineHeight',
  'letterSpacing',
  'textAlign',
  'textCase',
  'textDecoration',
  'textFills',
  'listStyle',
  'styles',
  'boundVariables',
  'interactions',
  'exports',
  'devStatus',
  'devChanged',
  'annotations',
  'codeLinks',
  'devResources',
  'componentId',
  'mainComponent',
  'slot',
  'pluginData',
] as const

/**
 * The design context of a layer: the properties a code generator needs, in the order Figma's
 * `get_design_context` reports them (geometry, layout, paint, type).
 */
export function buildDesignContext(node: unknown): Record<string, unknown> | null {
  if (!isRecord(node)) return null
  const context: Record<string, unknown> = {}
  for (const key of CONTEXT_KEYS) {
    const value = node[key]
    if (value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0)) {
      context[key] = value
    }
  }
  const children = Array.isArray(node.children) ? node.children : []
  if (children.length > 0) {
    context.children = children.map((child) => {
      if (!isRecord(child)) return child
      const summary: Record<string, unknown> = {
        id: child.id,
        name: child.name,
        type: toFigmaType(child.type),
      }
      if (typeof child.width === 'number') summary.width = child.width
      if (typeof child.height === 'number') summary.height = child.height
      if (typeof child.characters === 'string') summary.characters = child.characters
      return summary
    })
  }
  return context
}

/** Figma ids are strings ("1:2"); FigCraft ids are numbers. Keep FigCraft's, but stringy for clients. */
export function figmaId(id: number): string {
  return String(id)
}
