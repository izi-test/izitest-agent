// Register shared agent tools as MCP tools.
// Called once during MCP server setup alongside browser and test tools.

import { z } from 'zod';
import { AGENT_TOOLS } from './tools.js';

/**
 * Convert a JSON Schema property definition to a Zod schema.
 * Handles the subset used by our tool definitions.
 */
function jsonSchemaToZod(prop) {
  if (!prop) return z.any();
  switch (prop.type) {
    case 'string':
      return prop.enum ? z.enum(prop.enum) : z.string();
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'object':
      return z.record(z.any());
    case 'array':
      return z.array(z.any());
    default:
      return z.any();
  }
}

/**
 * Convert a tool's JSON Schema parameters to a Zod shape for MCP.
 */
function buildZodShape(parameters) {
  const shape = {};
  const props = parameters.properties || {};
  const required = new Set(parameters.required || []);

  for (const [key, prop] of Object.entries(props)) {
    let schema = jsonSchemaToZod(prop);
    if (prop.description) schema = schema.describe(prop.description);
    if (!required.has(key)) schema = schema.optional();
    shape[key] = schema;
  }
  return shape;
}

/**
 * Register all shared agent tools on an MCP server instance.
 */
export function registerAgentTools(server) {
  for (const tool of AGENT_TOOLS) {
    const zodShape = buildZodShape(tool.parameters);

    server.tool(
      tool.name,
      tool.description,
      zodShape,
      async (params) => {
        const result = tool.handler(params);
        if (result.error) {
          return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
        }
        const text = result.data
          ? JSON.stringify(result.data, null, 2)
          : (result.text || 'OK');
        return { content: [{ type: 'text', text }] };
      }
    );
  }
}
