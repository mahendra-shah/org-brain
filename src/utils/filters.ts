/**
 * ==============================================================================
 * OmniBrain Security & Moderation Filters
 * ==============================================================================
 */

// Regex patterns to block sensitive queries from hitting the LLM/Notion MCP
const SENSITIVE_PATTERNS = [
  /\bconfidential\b/i,
  /\bsalary\b/i,
  /\blegal\b/i,
  /\bpassword\b/i,
  /\bsecret\b/i,
  /\bpayroll\b/i,
  /\bfinancials\b/i,
  /\bcredential\b/i
];

/**
 * Checks if a query string contains highly sensitive terms that violate company policy.
 * @param query The input prompt from the user.
 * @returns true if sensitive, false otherwise.
 */
export function isQuerySensitive(query: string): boolean {
  return SENSITIVE_PATTERNS.some(pattern => pattern.test(query));
}

/**
 * Returns a secure block message.
 */
export function getSensitiveBlockMessage(): string {
  return "🚨 **Security Notice**: Your query contains keywords that are flagged as confidential or sensitive by organization policy. OmniBrain is restricted from searching these terms to prevent data exposure.";
}
