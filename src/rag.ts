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
  private taskDatabasesCache: { name: string; id: string; assigneeProps: string[]; createdTimeProp: string | null }[] = [];
  private usersCache: { id: string; name: string; email?: string }[] = [];

  constructor(mcpClient: NotionMCPClient, llmClient: LLMClient, databasesMap: string) {
    this.mcpClient = mcpClient;
    this.llmClient = llmClient;
    this.databasesMap = databasesMap;
    this.cache = new MemoryCache();
  }

  /**
   * Discovers and pre-caches the schemas of all task-related databases in the workspace.
   */
  public async initialize(): Promise<void> {
    const regex = /-\s*"([^"]+)"\s*\(ID:\s*([^)]+)\)/g;
    let match;
    const candidates: { name: string; id: string }[] = [];
    
    while ((match = regex.exec(this.databasesMap)) !== null) {
      const name = match[1];
      const id = match[2].trim();
      if (name.toLowerCase().includes("task")) {
        candidates.push({ name, id });
      }
    }
    
    if (candidates.length === 0) {
      console.log("🔍 [RAG Init] No task-related databases found in databasesMap.");
      return;
    }
    
    console.log(`🔍 [RAG Init] Discovered ${candidates.length} task database candidates. Resolving schemas in parallel...`);
    
    const resolved = await Promise.all(
      candidates.map(async (db) => {
        try {
          const schema = await this.mcpClient.callTool('API-retrieve-a-data-source', {
            data_source_id: db.id
          });
          
          let parsedSchema = this.parseMCPContent(schema);
          const props = parsedSchema?.properties || {};
          const assigneeProps: string[] = [];
          let createdTimeProp: string | null = null;
          
          for (const [propName, propVal] of Object.entries(props)) {
            const propValParsed = propVal as any;
            if (propValParsed && propValParsed.type === 'people') {
              const lowerName = propName.toLowerCase();
              const isAssignee = ['assign', 'engineer', 'captain', 'employee', 'owner', 'member', 'who'].some(keyword => lowerName.includes(keyword));
              if (isAssignee) {
                assigneeProps.push(propName);
              }
            }
            if (propValParsed && propValParsed.type === 'created_time') {
              createdTimeProp = propName;
            }
          }
          if (!createdTimeProp && props["Created time"]) {
            createdTimeProp = "Created time";
          }
          
          return { name: db.name, id: db.id, assigneeProps, createdTimeProp };
        } catch (err) {
          console.warn(`⚠️ [RAG Init] Failed to retrieve schema for database "${db.name}" (${db.id}):`, (err as Error).message);
          // Fallback defaults: generic potential assignee properties across different databases
          const defaultAssignees = ["Engineer", "Captain", "Assigned To", "Assignee"];
          return { name: db.name, id: db.id, assigneeProps: defaultAssignees, createdTimeProp: "Created time" };
        }
      })
    );
    
    this.taskDatabasesCache = resolved;
    console.log(`✓ [RAG Init] Pre-cached assignee properties for ${this.taskDatabasesCache.length} task databases:`, 
      this.taskDatabasesCache.map(d => `${d.name} (${d.assigneeProps.join(", ") || "none"})`)
    );

    // Pre-cache all users in the workspace to allow dynamic routing mapping
    try {
      console.log("🔍 [RAG Init] Pre-fetching workspace users for dynamic mapping...");
      const rawUsers = await this.mcpClient.callTool('API-get-users', {});
      const parsed = this.parseMCPContent(rawUsers);
      let results = [];
      if (parsed && parsed.results && Array.isArray(parsed.results)) {
        results = parsed.results;
      } else if (Array.isArray(parsed)) {
        results = parsed;
      }
      
      this.usersCache = results
        .filter((u: any) => u && u.id && u.name)
        .map((u: any) => ({
          id: u.id,
          name: u.name,
          email: u.person?.email
        }));
      console.log(`✓ [RAG Init] Pre-cached ${this.usersCache.length} workspace users.`);
    } catch (err) {
      console.warn("⚠️ [RAG Init] Failed to pre-cache workspace users:", (err as Error).message);
    }
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
    const routerPrompt = this.getRouterSystemPrompt(message, cleanedHistory, userContext);
    
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
          console.log(`  -> Executing: ${tc.name} with args:`, JSON.stringify(tc.args, null, 2));
          const rawResult = await this.mcpClient.callTool(tc.name, tc.args);
          
          let enhancedContent = "";
          
          // Programmatic Enhancement A: Search yields page content
          if (tc.name === 'API-post-search') {
            const results = this.parseMCPContent(rawResult);
            enhancedContent = await this.enhanceSearchResultsWithBlocks(results);
          }
          
          // Programmatic Enhancement B: User lookup yields tasks
          else if (tc.name === 'API-get-users') {
            const user = this.extractUserFromUsersList(rawResult, message, userContext);
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

  /**
   * Helper to check if the query refers to projects, databases, documents, or policies
   * dynamically, preventing fallback to the sender for general questions.
   */
  private containsDatabaseOrProjectName(queryLower: string): boolean {
    const regex = /-\s*"([^"]+)"/g;
    let match;
    const dbNames: string[] = [];
    while ((match = regex.exec(this.databasesMap)) !== null) {
      dbNames.push(match[1].toLowerCase());
    }

    for (const name of dbNames) {
      // Ignore generic keywords when searching for project/database names
      const cleanedName = name.replace(/\b(tasks|projects|database|system|onboarding|offboarding)\b/g, '').trim();
      if (cleanedName.length > 2) {
        if (queryLower.includes(cleanedName)) {
          return true;
        }
      }
    }

    // Additional common keywords in general/search queries
    if (
      queryLower.includes("datapivot") || 
      queryLower.includes("leave policy") || 
      queryLower.includes("onboarding") || 
      queryLower.includes("offboarding")
    ) {
      return true;
    }

    return false;
  }

  private extractUserFromUsersList(
    rawResult: any, 
    query: string, 
    userContext?: { name?: string; email?: string }
  ): { id: string; name: string } | null {
    const parsed = this.parseMCPContent(rawResult);
    let users = [];
    if (parsed && parsed.results && Array.isArray(parsed.results)) {
      users = parsed.results;
    } else if (Array.isArray(parsed)) {
      users = parsed;
    }

    const queryLower = query.toLowerCase();

    // 1. Check if any user's name from the database is explicitly mentioned in the query.
    let matchedUser: { id: string; name: string } | null = null;
    for (const u of users) {
      if (u && u.id && u.name) {
        const nameLower = u.name.toLowerCase();
        const words = nameLower.split(/\s+/);
        // Match whole words using regex to avoid substring false positives (e.g. "Dev" matching "developer")
        const match = words.some((w: string) => w.length > 2 && new RegExp(`\\b${w}\\b`, 'i').test(queryLower));
        if (match) {
          matchedUser = { id: u.id, name: u.name };
          break;
        }
      }
    }

    if (matchedUser) {
      return matchedUser;
    }

    // 2. Dynamic self-referential check
    // Check if there's any self-referential pronouns (my, me, i, myself, mine)
    const hasSelfPronoun = /\b(my|me|i|myself|mine)\b/i.test(queryLower);

    // Check if the query mentions any other user in the workspace
    let mentionsOtherUser = false;
    for (const u of users) {
      const isSender = userContext && (
        (userContext.email && u.person?.email?.toLowerCase() === userContext.email.toLowerCase()) ||
        (userContext.name && u.name?.toLowerCase() === userContext.name.toLowerCase())
      );
      if (isSender) continue;

      if (u.name) {
        const nameLower = u.name.toLowerCase();
        const words = nameLower.split(/\s+/);
        const match = words.some((w: string) => w.length > 2 && new RegExp(`\\b${w}\\b`, 'i').test(queryLower));
        if (match) {
          mentionsOtherUser = true;
          break;
        }
      }
    }

    // Determine if it is a general or project-specific query
    const isProjectOrGeneralQuery = 
      /\b(project|projects|database|databases|wiki|policy|policies|document|documents|all|everyone|team)\b/i.test(queryLower) ||
      this.containsDatabaseOrProjectName(queryLower);

    const isSelfReferential = hasSelfPronoun || (!mentionsOtherUser && !isProjectOrGeneralQuery);

    // 3. Fallback to sender's identity if self-referential
    if (isSelfReferential && userContext) {
      if (userContext.email) {
        const emailLower = userContext.email.toLowerCase();
        for (const u of users) {
          if (u && u.id && u.person?.email) {
            if (u.person.email.toLowerCase() === emailLower) {
              return { id: u.id, name: u.name };
            }
          }
        }
      }
      
      if (userContext.name) {
        const nameLower = userContext.name.toLowerCase();
        const userWords = nameLower.split(/\s+/);
        for (const u of users) {
          if (u && u.id && u.name) {
            const uNameLower = u.name.toLowerCase();
            const match = userWords.some((w: string) => w.length > 2 && uNameLower.includes(w));
            if (match) {
              return { id: u.id, name: u.name };
            }
          }
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
    let results: string[] = [];
    
    if (this.taskDatabasesCache.length === 0) {
      // Fallback if cache is empty
      const tasksDbId = this.getDatabaseIdByName("Tasks");
      if (tasksDbId) {
        this.taskDatabasesCache.push({
          name: "Tasks",
          id: tasksDbId,
          assigneeProps: ["Engineer", "Captain"],
          createdTimeProp: "Created time"
        });
      }
    }
    
    await Promise.all(
      this.taskDatabasesCache.map(async (db) => {
        if (db.assigneeProps.length === 0) return;
        
        try {
          console.log(`  💡 Smart Lookup: Programmatically querying "${db.name}" database for User ID: ${userId}...`);
          
          let filter: any = {};
          if (db.assigneeProps.length === 1) {
            filter = {
              property: db.assigneeProps[0],
              people: {
                contains: userId
              }
            };
          } else {
            filter = {
              or: db.assigneeProps.map(prop => ({
                property: prop,
                people: {
                  contains: userId
                }
              }))
            };
          }
          
          const queryArgs: any = {
            data_source_id: db.id,
            filter,
            page_size: 50
          };
          
          if (db.createdTimeProp) {
            queryArgs.sorts = [
              {
                property: db.createdTimeProp,
                direction: "descending"
              }
            ];
          }
          
          const rawTasks = await this.mcpClient.callTool('API-query-data-source', queryArgs);
          results.push(`--- ${db.name} Database ---\n${compressMCPToolResult(rawTasks)}`);
        } catch (err) {
          results.push(`--- ${db.name} Database Error ---\nFailed to query "${db.name}" database: ${(err as Error).message}`);
        }
      })
    );
    
    if (results.length === 0) {
      return "Error: No task databases found or successfully queried in workspace.";
    }
    
    return results.join("\n\n");
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

  private getDynamicUserMappings(query: string, history: any[], userContext?: { name?: string; email?: string }): string {
    const mentionedUsers = new Map<string, { id: string; name: string; email?: string }>();
    const queryLower = query.toLowerCase();
    
    // 1. Identify users mentioned in the query or history
    for (const u of this.usersCache) {
      if (u.name) {
        const nameLower = u.name.toLowerCase();
        const words = nameLower.split(/\s+/);
        const isMentionedInQuery = words.some((w: string) => w.length > 2 && new RegExp(`\\b${w}\\b`, 'i').test(queryLower));
        
        let isMentionedInHistory = false;
        for (const h of history) {
          if (h.content && h.content.toLowerCase().includes(nameLower)) {
            isMentionedInHistory = true;
            break;
          }
        }
        
        if (isMentionedInQuery || isMentionedInHistory) {
          mentionedUsers.set(u.id, u);
        }
      }
    }
    
    // 2. Identify the sender (userContext)
    if (userContext) {
      let sender: any = null;
      if (userContext.email) {
        sender = this.usersCache.find(u => u.email && u.email.toLowerCase() === userContext.email!.toLowerCase());
      }
      if (!sender && userContext.name) {
        sender = this.usersCache.find(u => u.name && u.name.toLowerCase().includes(userContext.name!.toLowerCase()));
      }
      if (sender) {
        mentionedUsers.set(sender.id, sender);
      }
    }
    
    // 3. Build the prompt text
    if (mentionedUsers.size === 0) {
      return "     (No specific user mappings detected in this turn. Use 'API-get-users' if you need to resolve a user ID.)";
    }
    
    let mappingText = "     Pre-mapped Notion User IDs for this query:\n";
    for (const u of mentionedUsers.values()) {
      mappingText += `     * ${u.name}: "${u.id}"${u.email ? ` (email: ${u.email})` : ''}\n`;
    }
    
    return mappingText;
  }

  private getRouterSystemPrompt(message: string, history: any[], userContext?: { name?: string; email?: string }): string {
    const projectsDbId = this.getDatabaseIdByName("Projects") || "166a93c7-c391-81f3-b038-000b036e8032";
    const tasksDbId = this.getDatabaseIdByName("Tasks") || "166a93c7-c391-81d4-a2c6-000b52a15e4b";

    // Generate the dynamic schema description and sort instructions for task databases
    let schemaNotes = "";
    let sortNotes = "";
    if (this.taskDatabasesCache.length > 0) {
      schemaNotes = "7. TASK DATABASES & ASSIGNEE PROPERTIES:\n" + 
        this.taskDatabasesCache
          .map(db => `   - "${db.name}" (ID: "${db.id}"): Query via filter on ${db.assigneeProps.map(p => `"${p}"`).join(" or ")} (people type).`)
          .join("\n") + 
        `\n   - CRITICAL: When querying a database, you MUST only filter by the exact property name listed above. Do NOT filter by properties that do not exist in that database, or it will cause a 400 Bad Request error!\n` +
        `   - Do NOT query the "Projects" database ("${projectsDbId}") for task-specific questions, as the Projects database only contains high-level project metadata pages.`;

      const dbListStr = this.taskDatabasesCache.map(db => `"${db.name}" database ("${db.id}")`).join(" or ");
      sortNotes = `   - When querying the ${dbListStr}, you MUST sort descending by creation date to get the most recently created or assigned tasks first. Pass:
     "sorts": [{"property": "Created time", "direction": "descending"}]`;
    } else {
      schemaNotes = `7. BHARAT FPO PROJECT SCOPE & SCHEMAS:
   - When asked about tasks in a project, they are looking for individual tasks. You MUST query the relevant task databases listed in the workspace.
   - Do NOT query the "Projects" database ("${projectsDbId}") for task-specific questions.`;
      sortNotes = `   - When querying task databases, you MUST sort descending by creation date (if the database schema supports it) to get the most recently created or assigned tasks first.`;
    }

    let prompt = `You are the Query Router for OmniBrain, a secure knowledge assistant.
Your task is to analyze the user's message and determine which Notion database query or search tool calls are required to gather the necessary context to answer the question.

CRITICAL INSTRUCTIONS:
1. DATA SOURCE RETRIEVAL & QUERYING:
   - All databases in this workspace are registered as Notion data sources. 
   - You MUST query them using 'API-query-data-source' (never call 'API-query-database').
   - You MUST retrieve database details or schemas using 'API-retrieve-a-data-source' (never call 'API-retrieve-a-database', or it will return a 404 Not Found error!).
2. SCHEMALESS QUERY FILTERING (AVOID 400 BAD REQUEST):
   - Notion API is extremely strict about filter properties and their exact option names. 
   - If you do not know the exact schema properties and option names (like for the Projects database), do NOT pass a 'filter' argument in 'API-query-data-source'. Instead, query the database UNFILTERED and let the Generator filter the results in-memory.
   - For example, do not try to guess a Status filter for the Projects database; query it unfiltered!
3. ONLY output tool calls to gather the necessary Notion database rows or documents. Do NOT write conversational answers. If the user's message is a simple greeting, thank you, or conversational query that does NOT need any Notion documents, output a normal direct text response and do NOT make any tool calls.
4. AVAILABLE WORKSPACE DATABASES:
Use these database IDs directly for querying. Do NOT call search APIs to find database IDs.
${this.databasesMap}

5. SPECIAL PEOPLE & TASK FILTERING (EXACT MATCHING):
   - When asked what tasks a user is working on:
     Call 'API-query-data-source' on the Tasks database.
${this.getDynamicUserMappings(message, history, userContext)}
     
     If a user is NOT in the pre-mapped list above, you MUST call 'API-get-users' in Turn 1 to look them up.
     
     Example Tasks database query filter:
     {
       "data_source_id": "${tasksDbId}",
       "filter": {
         "or": [
           { "property": "Engineer", "people": { "contains": "USER_ID" } },
           { "property": "Captain", "people": { "contains": "USER_ID" } }
         ]
       },
       "sorts": [
         { "property": "Created time", "direction": "descending" }
       ],
       "page_size": 50
     }
   - For general document searches (e.g. policies, onboarding wikis): Call 'API-post-search' with the key terms.
   
6. CHRONOLOGICAL SORTING:
${sortNotes}

${schemaNotes}

Output only the minimum necessary tool calls to answer the query.`;

    if (userContext && (userContext.name || userContext.email)) {
      prompt += `\n\n8. SENDER IDENTITY RESOLUTION (me/my/I):
   - The employee asking this query is: Name: "${userContext.name}", Email: "${userContext.email || 'unknown'}".
   - If the user uses self-referential terms (e.g. "my", "me", "myself", "I", "should I work on", "do I need to", "assigned to me"), resolve it to this identity ("${userContext.name}").
   - Match by email first: If their email ("${userContext.email}") matches any email listed in the pre-mapped list in section 5, you MUST use that mapped User ID directly instead of calling 'API-get-users'.
   - Find tasks assigned to them (using their user ID if mapped above, or looking them up by calling 'API-get-users').
   - This mapping only applies to user-specific queries (tasks, tickets, assignments). It does not apply to general projects, documents, or team policies.`;
    }

    return prompt;
  }

  private getGeneratorSystemPrompt(userContext?: { name?: string; email?: string }): string {
    let prompt = `You are OmniBrain, the secure knowledge Oracle for our organization.
Your task is to synthesize a professional, accurate, and grounded response to the employee's query strictly using the Notion context provided in the conversation.

CRITICAL INSTRUCTIONS:
1. Base your answer ONLY on the provided Notion context data. If the context does not contain the answer, state clearly that you cannot find it. Do not make up or hallucinate any facts.
2. Structure your response professionally. Use clean bullet points and headings.
3. When presenting lists of tasks, use standard Markdown task list syntax (e.g. '- [ ] Task Name' for active/backlog items) so the UI can render interactive visual checklists.
4. STRICT FILTERING (NO COMPLETED TASKS): 
   - Focus ONLY on active, pending, or in-progress tasks (e.g. status is "In Development", "QA", "Ready for Dev", "Backlog", "In progress", "Scoping", "Staging").
   - You MUST NEVER list completed, released, done, or archived tasks (e.g. status is "Released/ Done", "Complete", "Prod Ready", "Ready for handover", "Archived") under any circumstances, unless the user's question explicitly asks for completed, past, or history tasks. If the user asks "what are my tasks?" or "is there any task for me...", you must NOT list completed/released tasks.
5. STRICT PROJECT SCOPING:
   - If the user asks about tasks in a specific project (e.g., "Bharat FPO" or any other project), you MUST only include tasks that belong to that project. For tasks in the main Tasks database, check if their Project or Product rollup/relation property contains the requested project name. Do NOT list tasks from other projects.
6. NO BACKLOG/OTHER PEOPLES TASKS FOR USER QUERIES:
   - If the user asks "is there any task for me in project X?" and you find zero tasks assigned to them in that project, you MUST state "There are no tasks assigned to you in project X." You MUST NOT list the general backlog or tasks assigned to other team members in that project.
7. CHRONOLOGICAL ORDERING:
   - Present the tasks strictly in chronological order (most recently created or assigned tasks first) based on their "Created time" or "created_time" values. Keep the newest tasks at the top.
8. Cite sources by appending the exact document titles and links at the end of your response using standard markdown links like [Page Title](https://notion.so/page-id).`;

    if (userContext && userContext.name) {
      prompt += `\n\n9. PERSONALIZATION / SENDER CONTEXT:
   - The user asking this question is "${userContext.name}".
   - Address them directly and naturally (e.g., "Hi ${userContext.name}, here are your active tasks..." or "Your main focus is...").
   - CRITICAL: Speak naturally and confidently as if you already know exactly who they are. Do NOT write meta-explanations or explain how you resolved their identity. Never say "Since you're asking about 'my' task, I'm resolving this to your identity: ${userContext.name}" or "From the data fetched above". Just directly give them their tasks.`;
    }

    return prompt;
  }
}
