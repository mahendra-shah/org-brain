import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { config } from './config.js';

export class NotionMCPClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private isShuttingDown = false;

  async start() {
    this.isShuttingDown = false;
    console.log("Spawning Notion MCP Server subprocess...");
    
    // Create the stdio transport using npx to fetch and run the Notion MCP server
    this.transport = new StdioClientTransport({
      command: 'npx',
      args: ['-y', '@notionhq/notion-mcp-server'],
      env: {
        ...process.env,
        NOTION_TOKEN: config.notion.apiToken,
        NOTION_API_TOKEN: config.notion.apiToken
      }
    });

    this.client = new Client(
      { name: 'omnibrain-mcp-client', version: '1.0.0' },
      { capabilities: {} }
    );

    // Capture subprocess stderr logs for internal system tracking
    this.transport.stderr?.on('data', (chunk) => {
      console.warn(`[MCP Server stderr]: ${chunk.toString().trim()}`);
    });

    await this.client.connect(this.transport);
    console.log("Notion MCP Server successfully connected via stdio!");

    // Watchdog event handler for crash management
    this.transport.onclose = () => {
      if (!this.isShuttingDown) {
        console.error("⚠️ Notion MCP subprocess connection closed unexpectedly! Triggering supervisor auto-restart in 3 seconds...");
        setTimeout(() => {
          this.start().catch((err) => console.error("Supervisor failed to restart MCP server:", err));
        }, 3000);
      }
    };
  }

  async getTools() {
    if (!this.client) throw new Error("MCP client not initialized");
    const response = await this.client.listTools();
    return response.tools;
  }

  async callTool(name: string, args: any) {
    if (!this.client) throw new Error("MCP client not initialized");
    console.log(`Executing Notion tool: ${name} with arguments:`, args);
    
    // Enforce high-level API timeout of 10 seconds to prevent hanging queries
    const timeout = new Promise((_, reject) => 
      setTimeout(() => reject(new Error(`Notion MCP query timed out for tool ${name}`)), 10000)
    );

    const callPromise = this.client.callTool({ name, arguments: args });
    return await Promise.race([callPromise, timeout]);
  }

  async close() {
    this.isShuttingDown = true;
    if (this.transport) {
      await this.transport.close();
      console.log("Notion MCP Server connection closed cleanly.");
    }
  }
}
