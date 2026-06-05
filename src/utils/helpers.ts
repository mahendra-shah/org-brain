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
 * - Translates raw markdown tables to clean indented bullet lists.
 * - Appends diagnostic metadata block if SHOW_DEV_METADATA=true.
 */
export function formatSlackMessage(
  text: string, 
  usage?: { inputTokens: number, outputTokens: number }, 
  historyCount = 1,
  cached?: boolean,
  turns?: number
): string {
  let formatted = text;

  // 0. Convert raw Markdown tables to clean indented bullet lists (since Slack doesn't support tables)
  formatted = convertMarkdownTablesToLists(formatted);

  // 1. Convert standard Markdown Bold: **text** -> *text* (Slack mrkdwn uses single asterisks for bold)
  formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '*$1*');

  // 2. Convert standard Markdown Links: [Text](URL) -> <URL|Text>
  formatted = formatted.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<$2|$1>');

  // 3. Convert Markdown Headings to bold, uppercase Slack subheaders
  formatted = formatted.replace(/^(?:###|##|#)\s+(.+)$/gm, (_, headerText) => {
    return `*${headerText.toUpperCase()}*`;
  });

  // 3b. Convert standard Markdown Checkboxes to Slack emojis
  formatted = formatted.replace(/\[ \]/g, '⬜');
  formatted = formatted.replace(/\[[xX]\]/g, '✅');

  // 4. Append Developer Diagnostic Codeblock if SHOW_DEV_METADATA is enabled (Pro Tip check!)
  if (config.showDevMetadata && usage && (usage.inputTokens > 0 || usage.outputTokens > 0)) {
    const total = usage.inputTokens + usage.outputTokens;
    const modelName = config.llmProvider === 'deepseek' ? config.deepseek.model : config.claude.model;
    
    let meta = `\n\n\`\`\`\n[OrgBrain Dev Metadata]\n• Provider: ${config.llmProvider.toUpperCase()} (${modelName})\n`;
    meta += `• Tokens: Input: ${usage.inputTokens} | Output: ${usage.outputTokens} | Total: ${total}\n`;
    if (cached !== undefined) {
      meta += `• Cache Hit: ${cached ? '✅ Yes (Free Turn)' : '❌ No (Cache Miss)'}\n`;
    }
    if (turns !== undefined) {
      meta += `• RAG Turns: ${turns}\n`;
    }
    meta += `• Thread Context: ${historyCount} messages\n\`\`\``;
    
    formatted += meta;
  }

  return formatted;
}

/**
 * Parses raw Markdown table blocks and translates them into clean bulleted lists
 * with nested details. This allows tabular data to be readable on Slack and mobile.
 */
function convertMarkdownTablesToLists(text: string): string {
  const tableRegex = /((?:^|\n)\|[^\n]+\|+(?:\n\|[^\n]+\|+)+)/g;
  return text.replace(tableRegex, (match) => {
    const lines = match.trim().split('\n');
    if (lines.length < 3) return match; // Not a valid table

    const headers = lines[0]
      .split('|')
      .map(h => h.trim())
      .filter((h, idx, arr) => idx > 0 && idx < arr.length - 1);

    const isDivider = lines[1].includes('-') && lines[1].includes('|');
    if (!isDivider) return match;

    const listItems = [];
    for (let i = 2; i < lines.length; i++) {
      const cells = lines[i]
        .split('|')
        .map(c => c.trim())
        .filter((c, idx, arr) => idx > 0 && idx < arr.length - 1);

      if (cells.length === 0) continue;

      const title = cells[0];
      let itemStr = `• *${title}*`;

      const details = [];
      for (let j = 1; j < Math.min(headers.length, cells.length); j++) {
        if (headers[j] && cells[j]) {
          details.push(`  - *${headers[j]}*: ${cells[j]}`);
        }
      }

      if (details.length > 0) {
        itemStr += `\n${details.join('\n')}`;
      }
      listItems.push(itemStr);
    }

    return `\n${listItems.join('\n')}\n`;
  });
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
