import { config } from '../config.js';

/**
 * Safely splits a message string into chunks without cutting off paragraphs in the middle.
 * This ensures responses exceeding Slack's 4000-character limit are sent as clean, legible chunks.
 *
 * @param text The full input string to be split.
 * @param limit The maximum character size for each chunk (default 3800 to leave a safety buffer).
 * @returns Array of formatted string chunks.
 */
export function splitMessage(text: string, limit = 3800): string[] {
  if (text.length <= limit) return [text];
  
  const chunks: string[] = [];
  let currentChunk = '';
  
  const paragraphs = text.split('\n\n');
  for (const para of paragraphs) {
    // If a single paragraph itself is somehow longer than the limit, split by line or absolute boundary
    if (para.length > limit) {
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }
      
      let remaining = para;
      while (remaining.length > limit) {
        let splitIndex = remaining.lastIndexOf('\n', limit);
        if (splitIndex === -1 || splitIndex < limit * 0.5) {
          splitIndex = limit;
        }
        chunks.push(remaining.substring(0, splitIndex).trim());
        remaining = remaining.substring(splitIndex).trim();
      }
      currentChunk = remaining + '\n\n';
    } else if ((currentChunk + para).length > limit) {
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
      }
      currentChunk = para + '\n\n';
    } else {
      currentChunk += para + '\n\n';
    }
  }
  
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }
  
  return chunks;
}

/**
 * Strips all verbose system metadata fields (IDs, user structures, creation times) 
 * from raw JSON tool execution payloads. This yields an 80%+ token reduction 
 * while keeping essential content (titles, text properties, urls, select boxes) fully intact.
 */
export function compressMCPToolResult(result: any): string {
  if (!result) return "";
  
  // If it's a raw string, return or safely truncate it if exceptionally long
  if (typeof result === 'string') {
    if (result.length > 50000) {
      return result.substring(0, 50000) + "\n... [Content truncated due to size limits]";
    }
    return result;
  }
  
  try {
    // If it is an MCP response envelope containing a content block:
    if (result.content && Array.isArray(result.content)) {
      return result.content.map((item: any) => {
        if (item.text) {
          return compressMCPToolResult(item.text);
        }
        return JSON.stringify(item);
      }).join("\n");
    }

    // Try parsing if it is a JSON string
    let parsed = result;
    if (typeof result === 'string') {
      try {
        parsed = JSON.parse(result);
      } catch {
        parsed = result;
      }
    }
    
    // Deep structural cleanup
    const cleaned = cleanVerboseMetadata(parsed);
    const compressedStr = JSON.stringify(cleaned, null, 2);
    
    // Safety cap
    if (compressedStr.length > 50000) {
      return compressedStr.substring(0, 50000) + "\n... [JSON context truncated due to token budget limits]";
    }
    
    return compressedStr;
  } catch (e) {
    const fallback = JSON.stringify(result);
    return fallback.length > 50000 ? fallback.substring(0, 50000) + "\n... [Content truncated]" : fallback;
  }
}

/**
 * Securely masks sensitive integration tokens (e.g. ntn_45429...5TT) for safe display.
 */
export function maskToken(token: string): string {
  if (!token) return 'N/A';
  if (token.length <= 12) return '***';
  return `${token.substring(0, 6)}...${token.substring(token.length - 4)}`;
}

/**
 * Translates standard LLM markdown outputs into Slack's proprietary 'mrkdwn' format.
 * - Converts standard markdown bold (**text**) ➡️ Slack bold (*text*)
 * - Converts standard markdown links ([Text](URL)) ➡️ Slack links (<URL|Text>)
 * - Converts headings (### Header) ➡️ *HEADER* (bold uppercase)
 * - Appends diagnostic metadata block if SHOW_DEV_METADATA=true.
 */
export function formatSlackMessage(
  text: string, 
  usage?: { inputTokens: number, outputTokens: number }, 
  historyCount = 1
): string {
  let formatted = text;

  // 1. Convert standard Markdown Bold: **text** -> *text* (Slack mrkdwn uses single asterisks for bold)
  formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '*$1*');

  // 2. Convert standard Markdown Links: [Text](URL) -> <URL|Text>
  formatted = formatted.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<$2|$1>');

  // 3. Convert Markdown Headings to bold, uppercase Slack subheaders
  formatted = formatted.replace(/^(?:###|##|#)\s+(.+)$/gm, (_, headerText) => {
    return `*${headerText.toUpperCase()}*`;
  });

  // 4. Append Developer Diagnostic Codeblock if SHOW_DEV_METADATA is enabled (Pro Tip check!)
  if (config.showDevMetadata && usage && (usage.inputTokens > 0 || usage.outputTokens > 0)) {
    const total = usage.inputTokens + usage.outputTokens;
    const modelName = config.llmProvider === 'deepseek' ? config.deepseek.model : config.claude.model;
    
    formatted += `\n\n\`\`\`\n[OrgBrain Dev Metadata]\n• Provider: ${config.llmProvider.toUpperCase()} (${modelName})\n• Tokens: Input: ${usage.inputTokens} | Output: ${usage.outputTokens} | Total: ${total}\n• Thread Context: ${historyCount} messages\n\`\`\``;
  }

  return formatted;
}

function cleanVerboseMetadata(obj: any): any {
  if (obj === null || typeof obj !== 'object') return obj;
  
  if (Array.isArray(obj)) {
    return obj.map(cleanVerboseMetadata);
  }
  
  const cleaned: any = {};
  
  // Critical content keys we want to retain
  const keysToKeep = [
    'title', 'name', 'type', 'text', 'plain_text', 'content', 
    'rich_text', 'results', 'properties', 'url', 'expression',
    'cells', 'language', 'code', 'checked', 'select', 'multi_select',
    'number', 'date', 'start', 'end', 'status'
  ];
  
  for (const [key, value] of Object.entries(obj)) {
    // Exclude verbose API metadata, but retain critical id and object type tags for tool chaining
    if ([
      'created_time', 'last_edited_time', 
      'created_by', 'last_edited_by', 'avatar_url', 'href',
      'annotations', 'color', 'archived', 'has_children', 'parent'
    ].includes(key)) {
      continue;
    }
    
    if (keysToKeep.includes(key) || typeof value !== 'object') {
      cleaned[key] = cleanVerboseMetadata(value);
    } else {
      const nested = cleanVerboseMetadata(value);
      if (nested && Object.keys(nested).length > 0) {
        cleaned[key] = nested;
      }
    }
  }
  
  return cleaned;
}

/**
 * Strips any developer metadata block [OrgBrain Dev Metadata] and codeblocks
 * from messages retrieved from conversational history to keep thread memory clean.
 */
export function cleanHistoryMessage(text: string): string {
  if (!text) return "";
  // Strip out triple-backtick dev blocks or explicit metadata segments
  return text.replace(/(\n\n)?```\n\[OrgBrain Dev Metadata\][\s\S]*?```/g, '').trim();
}
