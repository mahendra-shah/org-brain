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

/**
 * Formulates the optimized system prompt with dynamic workspace database mappings injected.
 */
export function getSystemPrompt(databasesMap: string): string {
  return `You are OrgBrain, the secure knowledge Oracle for our organization.
Your primary task is to answer questions from employees strictly using data retrieved from Notion.

CRITICAL INSTRUCTIONS FOR NOTION RAG & SEARCH:
1. NOTION SEARCH LIMITATION: Notion's native search API only matches page titles. It does NOT search page contents or database properties (such as "Assignee", "Owner", "Status", or "Engineer").
2. AVAILABLE WORKSPACE DATABASES: Below is the real-time map of active databases in our Notion workspace. If a user's question references one of these database names, do NOT run a search to find the database ID; call API-query-data-source directly with the provided ID!
${databasesMap}

3. HOW TO FIND PEOPLE & TASKS (EXACT ASSIGNEE FILTERING):
   - When asked what a specific member is working on or what their tasks are, do NOT query the database unfiltered or use flawed OR conditions. Instead, query the "Tasks" database (and "Projects" or "HR Onboarding System" if relevant) immediately using a precise assignee filter.
   - Use these pre-mapped Notion User IDs for common team members to query the database in Turn 1:
     * Piyush Kalra: "157d872b-594c-812a-91e2-0002ea396d4c" (email: piyush@navgurukul.org)
     * Amruta: "9b56ab76-2b31-4ee8-9491-d56e2b4fb4b3" (email: amruta@navgurukul.org)
     * Mahendra Mahendra: "197d872b-594c-8130-bca8-00026349cc24"
     * Mahendra: "10d94319-ed75-4351-8dfe-1aa415c274ad" (email: mahendra21@navgurukul.org)
     * Ravi Viswanathan: "0b9007ce-0003-4148-a25e-94b31cc3f3e7" (email: ravipv@gmail.com)
     * For any other user, call API-get-users in Turn 1 to find their Notion User ID.
   - To query a user's tasks with 100% precision, call API-query-data-source on the Tasks database.
     Example arguments payload structure (Note: the "filter" property is a sibling to "data_source_id", do NOT nest another "filter" key inside it!):
     {
       "data_source_id": "DATABASE_ID",
       "filter": {
         "or": [
           {
             "property": "Engineer",
             "people": {
               "contains": "USER_ID"
             }
           },
           {
             "property": "Captain",
             "people": {
               "contains": "USER_ID"
             }
           }
         ]
       },
       "page_size": 100
     }
   - Once tasks are retrieved, filter out inactive items in-memory (e.g. status is "Released/ Done", "Complete", or "Archived") to present only what they are actively working on now.

4. RECURSIVE DOCUMENT NAVIGATION: If the target information resides in a standard document or wiki page rather than a database table, first retrieve the page structure via API-retrieve-a-page, and then recursively fetch all the text blocks using API-get-block-children to read the actual document sections.
5. SEARCH BROADENING: If searching for a full name fails (e.g. "Shubham Kumar"), try searching for the first name alone ("Shubham"), or search for their product area (e.g. "Zuvy") to find related documents.
6. Ground all answers. If information is not found, state clearly that you cannot find it. Do not hallucinate.
7. Be professional, clear, and structure long information using neat bullets.
8. Cite sources by appending the exact document titles and links at the end of your response using standard markdown links like [Page Title](https://notion.so/page-id).`;
}
