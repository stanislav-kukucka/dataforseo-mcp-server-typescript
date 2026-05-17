import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { DataForSEOClient, DataForSEOConfig } from '../core/client/dataforseo.client.js';
import { EnabledModulesSchema } from '../core/config/modules.config.js';
import { BaseModule, ToolDefinition } from '../core/modules/base.module.js';
import { ModuleLoaderService } from '../core/utils/module-loader.js';
import { version, name } from './version.worker.js';

/**
 * DataForSEO MCP Server for Cloudflare Workers
 * 
 * This server provides MCP (Model Context Protocol) access to DataForSEO APIs
 * through a Cloudflare Worker runtime using the agents/mcp pattern.
 */

// Server metadata
const SERVER_NAME = `${name} (Worker)`;
const SERVER_VERSION = version;
globalThis.__PACKAGE_VERSION__ = version;
globalThis.__PACKAGE_NAME__ = name;
/**
 * DataForSEO MCP Agent for Cloudflare Workers
 */
export class DataForSEOMcpAgent extends McpAgent {
  server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  constructor(ctx: DurableObjectState, protected env: Env){
    super(ctx, env);
  }

  async init() {
    const workerEnv = this.env || (globalThis as any).workerEnv;
    if (!workerEnv) {
      throw new Error(`Worker environment not available`);
    }

    // Initialize DataForSEO client
    const dataForSEOConfig: DataForSEOConfig = {
      username: workerEnv.DATAFORSEO_USERNAME || "",
      password: workerEnv.DATAFORSEO_PASSWORD || "",
    };
    
    const dataForSEOClient = new DataForSEOClient(dataForSEOConfig);
    
    // Parse enabled modules from environment
    const enabledModules = EnabledModulesSchema.parse(workerEnv.ENABLED_MODULES);
    
    // Initialize and load modules
    const modules: BaseModule[] = ModuleLoaderService.loadModules(dataForSEOClient, enabledModules);
    
    const enabledPromptsRaw = (workerEnv as unknown as Record<string, string>)['ENABLED_PROMPTS'] as string | undefined;
    const enabledPrompts = enabledPromptsRaw ? enabledPromptsRaw.split(',').map(name => name.trim()) : [];

    // Register tools and prompts from all modules
    modules.forEach(module => {
      const tools = module.getTools();
      Object.entries(tools).forEach(([name, tool]) => {
        const typedTool = tool as ToolDefinition;
        const schema = z.object(typedTool.params);
        this.server.tool(
          name,
          typedTool.description,
          schema.shape,
          typedTool.handler
        );
      });

      const prompts = module.getPrompts();
      const allowedPrompts = enabledPrompts.length === 0
        ? prompts
        : Object.fromEntries(Object.entries(prompts).filter(([promptName]) => enabledPrompts.includes(promptName)));

      Object.entries(allowedPrompts).forEach(([name, prompt]) => {
        this.server.registerPrompt(
          name,
          {
            description: prompt.description,
            argsSchema: prompt.params,
          },
          prompt.handler
        );
      });
    });
  }
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, Mcp-Session-Id',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
};

function addCors(response: Response): Response {
  const r = new Response(response.body, response);
  for (const [k, v] of Object.entries(CORS_HEADERS)) r.headers.set(k, v);
  return r;
}


export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Store environment in global context for McpAgent access
    (globalThis as any).workerEnv = env;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Health check endpoint
    if (url.pathname === '/health' && request.method === 'GET') {
      return new Response(JSON.stringify({
        status: 'healthy',
        server: SERVER_NAME,
        version: SERVER_VERSION,
        timestamp: new Date().toISOString()
      }), {
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
      });
    }

    // MCP endpoints using McpAgent pattern
    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      const response = await DataForSEOMcpAgent.serveSSE("/sse").fetch(request, env, ctx);
      return addCors(response);
    }

    if (url.pathname === "/mcp" || url.pathname === '/http') {
      const response = await DataForSEOMcpAgent.serve("/mcp").fetch(request, env, ctx);
      return addCors(response);
    }

    return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  },
};