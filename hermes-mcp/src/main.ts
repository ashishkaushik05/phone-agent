import { config } from "./config.ts";
import { buildHttpServer } from "./server.ts";

const server = buildHttpServer({ baseUrl: config.hermesCoreUrl, token: config.token });
server.listen(config.port, () => {
  console.log(`hermes-mcp listening on :${config.port}  (hermes-core: ${config.hermesCoreUrl})`);
  console.log(`  MCP  http://localhost:${config.port}/mcp  (bearer required)`);
});
