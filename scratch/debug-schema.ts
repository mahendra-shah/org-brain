import { NotionMCPClient } from '../src/mcp.js';

async function main() {
  const mcpClient = new NotionMCPClient();
  await mcpClient.start();
  try {
    const databaseId = '166a93c7-c391-81f3-b038-000b036e8032';
    const schema = await mcpClient.callTool('API-retrieve-a-data-source', {
      data_source_id: databaseId
    });
    console.log("SCHEMA:", JSON.stringify(schema, null, 2));
  } catch (err) {
    console.error("Error retrieving schema:", err);
  } finally {
    await mcpClient.close();
  }
}

main();
