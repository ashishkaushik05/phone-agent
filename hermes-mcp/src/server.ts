import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { TOOLS, runTool } from "./tools.ts";
import type { HermesClientDeps } from "./hermesClient.ts";

/** Builds the McpServer and registers every tool from TOOLS against it. Split out from
 *  buildHttpServer so a test can exercise tool registration without a real HTTP transport. */
export function buildMcpServer(deps: HermesClientDeps): McpServer {
  const server = new McpServer({ name: "hermes-mcp", version: "0.0.1" });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args) => runTool(tool, args ?? {}, deps),
    );
  }
  return server;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

/** The whole point of this server: one path, `/mcp`, gated by the shared bearer, in front of
 *  the MCP Streamable HTTP transport — run in **stateless** mode (`sessionIdGenerator:
 *  undefined`): a fresh McpServer + transport per request, torn down once the response
 *  closes. Every tool here is a stateless REST proxy with nothing to preserve between calls,
 *  so a persistent multi-request session would buy nothing but complexity — and a single
 *  shared stateful transport turned out to reject a second client's `initialize` outright
 *  ("Server already initialized"), so per-request is also the only option that supports more
 *  than one concurrent MCP client. */
export function buildHttpServer(deps: HermesClientDeps & { token: string }): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (req.headers.authorization !== `Bearer ${deps.token}`) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const mcpServer = buildMcpServer(deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void mcpServer.close();
    });
    try {
      await mcpServer.connect(transport);
      const body = req.method === "POST" ? await readJsonBody(req) : undefined;
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: (err as Error).message }));
      }
    }
  });
}
