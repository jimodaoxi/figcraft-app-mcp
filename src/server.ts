import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { registerTools, type ToolDeps } from './tools.js'

export const SERVER_NAME = 'figcraft-app-mcp'
export const SERVER_VERSION = '0.1.0'

const INSTRUCTIONS = [
  'Drives the local FigCraft desktop app through its loopback control channel.',
  '',
  'Two tool families are exposed:',
  '- FigCraft-native tools (list_commands, run_command, batch, create_node, set_properties,',
  '  inspect_document, get_node, select, export, screenshot, open_file, save_file, undo, redo,',
  '  pointer, key, type_text, inspect_ui) mirror the upstream figcraft-mcp server.',
  '- Figma-compatible tools (get_metadata, get_design_context, get_screenshot,',
  '  get_code_connect_map, get_variable_defs, get_code) mirror the Figma desktop MCP, so an',
  '  agent that knows Figma can drive FigCraft with the same vocabulary.',
  '',
  'Conventions: coordinates are page units (1 unit = 1 px at 100% zoom), x right, y down;',
  'create_node and set_properties take x/y relative to the parent frame; colours are',
  '"#RRGGBB" or "#RRGGBBAA"; every mutation is one undo step.',
  '',
  'Verify your work: inspect_document / get_node for numbers, screenshot for pixels.',
].join('\n')

export function createServer(deps: ToolDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: INSTRUCTIONS,
    },
  )
  registerTools(server, deps)
  return server
}

export async function serveStdio(server: McpServer): Promise<void> {
  await server.connect(new StdioServerTransport())
}
