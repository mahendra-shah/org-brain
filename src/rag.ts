import { NotionMCPClient } from './mcp.js';
import { LLMClient } from './llm.js';
import { config } from './config.js';
import { compressMCPToolResult, cleanHistoryMessage } from './utils/helpers.js';

export interface RAGResponse {
  text: string;
  citations: { title: string; url: string }[];
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  turns: number;
  cached: boolean;
}

/**
 * A simple, high-performance in-memory cache with TTL and thread-aware key normalization.
 */
export class MemoryCache {
  private cache = new Map<string, { response: RAGResponse; expiresAt: number }>();
  private ttlMs: number;

  constructor(ttlSeconds = 900) { // Default to 15 minutes (900 seconds)
    this.ttlMs = ttlSeconds * 1000;
  }

  /**
   * Generates a normalized cache key combining the message and conversation history.
   */
  private generateKey(message: string, history: any[]): string {
    const cleanMsg = this.normalizeText(message);
    
    // Incorporate the last 3 turns of conversational history to keep thread memory segregated
    const historyContext = history
      .slice(-3)
      .map(h => `${h.role}:${this.normalizeText(h.content || '')}`)
      .join('|');

    return `${historyContext}#${cleanMsg}`;
  }

  private normalizeText(text: string): string {
    return text
      .toLowerCase()
      .trim()
      .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g, "")
      .replace(/\s+/g, " ");
  }

  public get(message: string, history: any[]): RAGResponse | null {
    const key = this.generateKey(message, history);
    const entry = this.cache.get(key);
    
    if (!entry) return null;
    
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    
    return entry.response;
  }

  public set(message: string, history: any[], response: RAGResponse): void {
    const key = this.generateKey(message, history);
    this.cache.set(key, {
      response,
      expiresAt: Date.now() + this.ttlMs
    });
  }

  public clear(): void {
    this.cache.clear();
  }
}

/**
 * Core Orchestrator implementing the Router-Generator Split (Single-Turn RAG)
 * and programmatic parallel context harvesting.
 */
export class RAGService {
  private mcpClient: NotionMCPClient;
  private llmClient: LLMClient;
  private databasesMap: string;
  private cache: MemoryCache;

  constructor(mcpClient: NotionMCPClient, llmClient: LLMClient, databasesMap: string) {
    this.mcpClient = mcpClient;
    this.llmClient = llmClient;
    this.databasesMap = databasesMap;
    this.cache = new MemoryCache();
  }

  /**
   * Executes the RAG flow.
   */
  public async execute(message: string, history: any[], userContext?: { name?: string; email?: string }): Promise<RAGResponse> {
    // 1. Cache Lookup
    const cachedResponse = this.cache.get(message, history);
    if (cachedResponse) {
      console.log(`⚡️ Cache hit for query: "${message}"`);
      return {
        ...cachedResponse,
        cached: true
      };
    }

    console.log(`🔍 Cache miss. Executing Router-Generator RAG pipeline for query: "${message}"`);
    
    // Clean history items text
    const cleanedHistory = history.map(h => ({
      role: h.role,
      content: cleanHistoryMessage(h.content || '')
    }));

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let turns = 0;

    // Fetch all read-only tools
    const mcpTools = await this.mcpClient.getTools();
    const filteredTools = mcpTools.filter(tool => {
      const name = tool.name.toLowerCase();
      return name.startsWith('api-get-') || 
             name.startsWith('api-retrieve-') || 
             name.includes('search') || 
             name.includes('query');
    });

    // ==========================================
    // STAGE 1: ROUTING & PARAM EXTRACTION
    // ==========================================
    turns++;
    const routerPrompt = this.getRouterSystemPrompt(userContext);
    
    // Router LLM call - ask LLM to extract tool calls
    const routerResult = await this.llmClient.generateResponse(
      routerPrompt, 
      [...cleanedHistory, { role: 'user', content: message }], 
      filteredTools
    );

    totalInputTokens += routerResult.usage?.inputTokens || 0;
    totalOutputTokens += routerResult.usage?.outputTokens || 0;

    const toolCalls = routerResult.toolCalls;

    // If Router returned no tool calls, it's a direct conversational/greeting response
    if (!toolCalls || toolCalls.length === 0) {
      console.log("💬 Router did not trigger any tool calls. Returning direct model response.");
      const directResponse: RAGResponse = {
        text: routerResult.text,
        citations: [],
        usage: {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens
        },
        turns,
        cached: false
      };
      
      this.cache.set(message, history, directResponse);
      return directResponse;
    }

    console.log(`⚙️ Router selected ${toolCalls.length} tool(s) to execute in parallel:`, toolCalls.map(tc => tc.name));

    // ==========================================
    // STAGE 2: PARALLEL EXECUTION & ENHANCEMENT
    // ==========================================
    const toolResults = await Promise.all(
      toolCalls.map(async (tc) => {
        try {
          console.log(`  -> Executing: ${tc.name}`);
          const rawResult = await this.mcpClient.callTool(tc.name, tc.args);
          
          let enhancedContent = "";
          
          // Programmatic Enhancement A: Search yields page content
          if (tc.name === 'API-post-search') {
            const results = this.parseMCPContent(rawResult);
            enhancedContent = await this.enhanceSearchResultsWithBlocks(results);
          }
          
          // Programmatic Enhancement B: User lookup yields tasks
          else if (tc.name === 'API-get-users') {
            const user = this.extractUserFromUsersList(rawResult, message);
            if (user && this.isQueryTaskRelated(message)) {
              console.log(`  💡 Smart Lookup: Resolved name to User ID: ${user.id} (${user.name}). Programmatically querying Tasks...`);
              const tasksData = await this.fetchTasksForUser(user.id);
              enhancedContent = `\n[Programmatic Task Retrieval for User "${user.name}" (ID: ${user.id})]:\n${tasksData}`;
            }
          }

          const compressed = compressMCPToolResult(rawResult);
          return {
            toolName: tc.name,
            content: compressed + (enhancedContent ? `\n\n${enhancedContent}` : '')
          };
        } catch (err) {
          console.error(`Notion execution error in Router-Generator pipeline for ${tc.name}:`, err);
          return {
            toolName: tc.name,
            content: `Error retrieving data source: ${(err as Error).message}`
          };
        }
      })
    );

    // Compile retrieve context
    const contextString = toolResults
      .map(tr => `--- START NOTION DATA: ${tr.toolName} ---\n${tr.content}\n--- END NOTION DATA ---`)
      .join('\n\n');

    // ==========================================
    // STAGE 3: FINAL SYNTHESIS (GENERATOR)
    // ==========================================
    turns++;
    const generatorPrompt = this.getGeneratorSystemPrompt(userContext);
    
    // Construct single-turn synthesis input (No tool definitions passed to keep context small!)
    const generatorHistory = [
      ...cleanedHistory,
      {
        role: 'user',
        content: `Here is the real-time context retrieved from Notion:\n\n${contextString}\n\nUser Question: ${message}`
      }
    ];

    console.log("✍️ Invoking Generator for final answer synthesis...");
    const generatorResult = await this.llmClient.generateResponse(
      generatorPrompt,
      generatorHistory,
      [] // Empty tools list: forces direct generation and drops prompt schema overhead
    );

    totalInputTokens += generatorResult.usage?.inputTokens || 0;
    totalOutputTokens += generatorResult.usage?.outputTokens || 0;

    // Automatically extract citations
    const citations: { title: string; url: string }[] = [];
    const notionUrlRegex = /\[([^\]]+)\]\((https:\/\/www\.notion\.so\/[a-zA-Z0-9-_\/]+)\)/g;
    let match;
    while ((match = notionUrlRegex.exec(generatorResult.text)) !== null) {
      citations.push({
        title: match[1],
        url: match[2]
      });
    }

    const finalResponse: RAGResponse = {
      text: generatorResult.text,
      citations,
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens
      },
      turns,
      cached: false
    };

    // Store in Cache
    this.cache.set(message, history, finalResponse);
    return finalResponse;
  }

  // ==========================================
  // HELPERS & PROGRAMMATIC OPTIMIZATIONS
  // ==========================================

  private parseMCPContent(rawResult: any): any {
    if (!rawResult) return null;
    let parsedResult = rawResult;
    
    if (rawResult.content && Array.isArray(rawResult.content)) {
      const textItem = rawResult.content.find((item: any) => item.text);
      if (textItem) {
        try {
          parsedResult = JSON.parse(textItem.text);
        } catch {
          parsedResult = textItem.text;
        }
      }
    }
    
    if (typeof parsedResult === 'string') {
      try {
        parsedResult = JSON.parse(parsedResult);
      } catch {}
    }
    
    return parsedResult;
  }

  private async enhanceSearchResultsWithBlocks(results: any): Promise<string> {
    if (!results) return "";
    
    let items = [];
    if (results.results && Array.isArray(results.results)) {
      items = results.results;
    } else if (Array.isArray(results)) {
      items = results;
    }
    
    const pages = items.filter((item: any) => item && (item.object === 'page' || item.type === 'page'));
    if (pages.length === 0) return "";

    // Programmatically fetch block children for top 2 pages
    const topPages = pages.slice(0, 2);
    console.log(`  💡 Smart Lookup: Fetching block children for top ${topPages.length} search page results...`);
    
    const blockFetches = topPages.map(async (page: any) => {
      try {
        let title = "Unnamed Page";
        if (page.properties) {
          for (const key of Object.keys(page.properties)) {
            const prop = page.properties[key];
            if (prop.title && Array.isArray(prop.title)) {
              title = prop.title.map((t: any) => t.plain_text || '').join('');
              break;
            }
          }
        }
        
        const rawBlocks = await this.mcpClient.callTool('API-get-block-children', { block_id: page.id });
        const compressedBlocks = compressMCPToolResult(rawBlocks);
        return `[Content of Page "${title}" (ID: ${page.id})]:\n${compressedBlocks}`;
      } catch (err) {
        return `[Failed to fetch content for page ${page.id}]: ${(err as Error).message}`;
      }
    });

    const blockTexts = await Promise.all(blockFetches);
    return blockTexts.join('\n\n');
  }

  private extractUserFromUsersList(rawResult: any, query: string): { id: string; name: string } | null {
    const parsed = this.parseMCPContent(rawResult);
    let users = [];
    if (parsed && parsed.results && Array.isArray(parsed.results)) {
      users = parsed.results;
    } else if (Array.isArray(parsed)) {
      users = parsed;
    }

    const queryLower = query.toLowerCase();
    
    for (const u of users) {
      if (u && u.id && u.name) {
        const nameLower = u.name.toLowerCase();
        // Match user name against terms in user query
        const words = nameLower.split(/\s+/);
        const match = words.some((w: string) => w.length > 2 && queryLower.includes(w));
        if (match) {
          return { id: u.id, name: u.name };
        }
      }
    }
    return null;
  }

  private isQueryTaskRelated(query: string): boolean {
    const keywords = ['task', 'work', 'ticket', 'assign', 'do', 'action', 'project'];
    const queryLower = query.toLowerCase();
    return keywords.some(k => queryLower.includes(k));
  }

  private async fetchTasksForUser(userId: string): Promise<string> {
    const tasksDbId = this.getDatabaseIdByName("Tasks");
    if (!tasksDbId) {
      console.warn("⚠️ Could not locate Tasks database in workspace schema map. Programmatic tasks fetch skipped.");
      return "Error: Tasks database ID not found.";
    }

    try {
      const rawTasks = await this.mcpClient.callTool('API-query-data-source', {
        data_source_id: tasksDbId,
        filter: {
          or: [
            {
              property: "Engineer",
              people: {
                contains: userId
              }
            },
            {
              property: "Captain",
              people: {
                contains: userId
              }
            }
          ]
        },
        page_size: 50
      });
      return compressMCPToolResult(rawTasks);
    } catch (err) {
      return `Failed to query Tasks database: ${(err as Error).message}`;
    }
  }

  private getDatabaseIdByName(name: string): string | null {
    const regex = new RegExp(`-\\s*"${name}"\\s*\\(ID:\\s*([^)]+)\\)`, 'i');
    const match = this.databasesMap.match(regex);
    if (match) return match[1].trim();
    
    // Fallback: search broad name matching
    const regexFallback = new RegExp(`"([^"]*${name}[^"]*)"\\s*\\(ID:\\s*([^)]+)\\)`, 'i');
    const matchFallback = this.databasesMap.match(regexFallback);
    if (matchFallback) return matchFallback[2].trim();
    
    return null;
  }

  // ==========================================
  // SYSTEM PROMPT BUILDERS
  // ==========================================

  private getRouterSystemPrompt(userContext?: { name?: string; email?: string }): string {
    let prompt = `You are the Query Router for OrgBrain, a secure knowledge assistant.
Your task is to analyze the user's message and determine which Notion database query or search tool calls are required to gather the necessary context to answer the question.

CRITICAL INSTRUCTIONS:
1. ONLY output tool calls to gather the necessary Notion database rows or documents. 
2. Do NOT write conversational answers. ONLY output tool calls. If the user's message is a simple greeting, thank you, or conversational query that does NOT need any Notion documents, output a normal direct text response and do NOT make any tool calls.
3. AVAILABLE WORKSPACE DATABASES:
Use these database IDs directly for querying. Do NOT call search APIs to find database IDs.
${this.databasesMap}

4. SPECIAL PEOPLE & TASK FILTERING (EXACT MATCHING):
   - When asked what tasks a user (e.g. Amruta, Piyush, Mahendra, Ravi) is working on:
     Call 'API-query-data-source' on the Tasks database.
     Pre-mapped Notion User IDs:
     * Piyush Kalra: "157d872b-594c-812a-91e2-0002ea396d4c" (email: piyush@navgurukul.org)
     * Amruta: "9b56ab76-2b31-4ee8-9491-d56e2b4fb4b3" (email: amruta@navgurukul.org)
     * Mahendra Mahendra: "197d872b-594c-8130-bca8-00026349cc24"
     * Mahendra: "10d94319-ed75-4351-8dfe-1aa415c274ad" (email: mahendra21@navgurukul.org)
     * Ravi Viswanathan: "0b9007ce-0003-4148-a25e-94b31cc3f3e7" (email: ravipv@gmail.com)
     
     If a user is NOT in this list (e.g., a new user name), call 'API-get-users' in Turn 1 to look them up.
     
     Example Tasks database query filter:
     {
       "data_source_id": "TASKS_DATABASE_ID",
       "filter": {
         "or": [
           { "property": "Engineer", "people": { "contains": "USER_ID" } },
           { "property": "Captain", "people": { "contains": "USER_ID" } }
         ]
       },
       "page_size": 50
     }
   - For project tracking: Call 'API-query-data-source' on the Projects database.
   - For general document searches (e.g. policies, onboarding wikis): Call 'API-post-search' with the key terms.

Output only the minimum necessary tool calls to answer the query.`;

    if (userContext && (userContext.name || userContext.email)) {
      prompt += `\n\n5. SENDER IDENTITY RESOLUTION (me/my/I):
   - The employee asking this query is: Name: "${userContext.name}", Email: "${userContext.email || 'unknown'}".
   - If the user uses self-referential terms (e.g. "my", "me", "myself", "I", "should I work on", "do I need to", "assigned to me"), resolve it to this identity ("${userContext.name}").
   - Find tasks assigned to them (using their user ID if mapped above, or looking them up by calling 'API-get-users').
   - This mapping only applies to user-specific queries (tasks, tickets, assignments). It does not apply to general projects, documents, or team policies.`;
    }

    return prompt;
  }

  private getGeneratorSystemPrompt(userContext?: { name?: string; email?: string }): string {
    let prompt = `You are OrgBrain, the secure knowledge Oracle for our organization.
Your task is to synthesize a professional, accurate, and grounded response to the employee's query strictly using the Notion context provided in the conversation.

CRITICAL INSTRUCTIONS:
1. Base your answer ONLY on the provided Notion context data. If the context does not contain the answer, state clearly that you cannot find it. Do not make up or hallucinate any facts.
2. Structure your response professionally. Use clean bullet points and headings.
3. When presenting lists of tasks, use standard Markdown task list syntax (e.g. '- [ ] Task Name' for active/backlog items and '- [x] Task Name' for completed items) so the UI can render interactive visual checklists.
4. Filter out inactive items (e.g., status is "Released/ Done", "Complete", or "Archived") in-memory when asked what someone is working on, presenting only what they are actively working on now.
5. Cite sources by appending the exact document titles and links at the end of your response using standard markdown links like [Page Title](https://notion.so/page-id).`;

    if (userContext && userContext.name) {
      prompt += `\n\n6. PERSONALIZATION / SENDER CONTEXT:
   - The user asking this question is "${userContext.name}".
   - Address them directly and naturally (e.g., "Hi Mahendra, here are your active tasks..." or "Your main focus is...").
   - CRITICAL: Speak naturally and confidently as if you already know exactly who they are. Do NOT write meta-explanations or explain how you resolved their identity. Never say "Since you're asking about 'my' task, I'm resolving this to your identity: Mahendra" or "From the data fetched above". Just directly give them their tasks.`;
    }

    return prompt;
  }
}
