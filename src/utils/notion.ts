import { NotionMCPClient } from '../mcp.js';

/**
 * Robustly queries all database schemas in the connected Notion workspace
 * and parses their titles and IDs to generate a clean metadata map.
 */
export async function fetchWorkspaceDatabases(mcpClient: NotionMCPClient): Promise<string> {
  try {
    console.log("🔍 Pre-fetching workspace database metadata for zero-search RAG routing...");
    
    // We execute a broad search filtering for databases using the correct MCP tool name
    const rawResult = await mcpClient.callTool('API-post-search', {
      query: '',
      filter: { property: 'object', value: 'data_source' },
      page_size: 100
    });
    
    // Extricate JSON payload from MCP standard content blocks
    let parsedResult: any = null;
    if (rawResult && (rawResult as any).content && Array.isArray((rawResult as any).content)) {
      const textItem = (rawResult as any).content.find((item: any) => item.text);
      if (textItem) {
        try {
          parsedResult = JSON.parse(textItem.text);
        } catch {
          parsedResult = textItem.text;
        }
      }
    } else {
      parsedResult = rawResult;
    }
    
    // Double-check if the text itself needs structural parsing
    if (typeof parsedResult === 'string') {
      try {
        parsedResult = JSON.parse(parsedResult);
      } catch {}
    }
    
    // Standardize results extraction across possible MCP payloads
    let results = [];
    if (parsedResult) {
      if (parsedResult.results && Array.isArray(parsedResult.results)) {
        results = parsedResult.results;
      } else if (Array.isArray(parsedResult)) {
        results = parsedResult;
      } else if (parsedResult.content && Array.isArray(parsedResult.content)) {
        results = parsedResult.content;
      }
    }
    
    const databases: { name: string, id: string }[] = [];
    
    for (const item of results) {
      const isDb = item.object === 'database' || item.type === 'database' || item.object === 'data_source';
      if (isDb) {
        const id = item.id;
        let name = '';
        
        // Robust Notion API property parsing for database titles
        if (item.title && Array.isArray(item.title)) {
          name = item.title.map((t: any) => t.plain_text || t.text?.content || '').join('');
        } else if (typeof item.title === 'string') {
          name = item.title;
        }
        
        if (!name && item.properties) {
          // If title is nested in properties (common fallback)
          for (const key of Object.keys(item.properties)) {
            const prop = item.properties[key];
            if (prop.title && Array.isArray(prop.title)) {
              name = prop.title.map((t: any) => t.plain_text || '').join('');
              break;
            }
          }
        }
        
        name = name || 'Unnamed Database';
        databases.push({ name, id });
      }
    }
    
    if (databases.length === 0) {
      console.warn("⚠️ No databases were returned in search results. RAG will fall back to dynamic search.");
      return "- (No database schemas discovered. Use standard search tools)";
    }
    
    console.log(`✓ Discovered ${databases.length} active database schemas in Notion workspace!`);
    return databases.map(db => `- "${db.name}" (ID: ${db.id})`).join('\n');
    
  } catch (error) {
    console.warn("⚠️ Failed to pre-fetch Notion database metadata. RAG will fall back to dynamic search:", error);
    return "- (Pre-fetch failed. Use standard search tools)";
  }
}


