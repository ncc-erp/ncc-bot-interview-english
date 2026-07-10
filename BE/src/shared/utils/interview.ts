/**
 * Detects if the transcript represents a request by the candidate to repeat the question.
 */
export function isRepeatRequest(text: string): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase().trim().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g, "");
  const patterns = [
    /(?:can|could|would)\s+you\s+(?:please\s+)?repeat/i,
    /please\s+repeat/i,
    /repeat\s+please/i,
    /^(?:please\s+)?repeat\s+(?:the\s+)?(?:last\s+)?question(?:\s+again)?$/i,
    /^(?:please\s+)?repeat\s+(?:that|it|again)(?:\s+again)?$/i,
    /^(?:please\s+)?say\s+(?:that|it|again)\s+again$/i,
    /^(?:please\s+)?say\s+(?:that|it)\s+one\s+more\s+time$/i,
    /what\s+was\s+the\s+question/i,
    /didnt\s+hear\s+the\s+question/i,
    /couldnt\s+hear\s+the\s+question/i,
    /didnt\s+catch\s+that/i,
    /couldnt\s+catch\s+that/i,
    /^pardon(?:\s+me)?$/i,
  ];
  return patterns.some((regex) => regex.test(normalized));
}

/**
 * Detects if the candidate responds to greeting with a short confirmation/readiness keyword.
 */
export function isStartRequest(text: string): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase().trim().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g, "");
  const words = normalized.split(/\s+/);
  if (words.length <= 3) {
    const startKeywords = ['ready', 'start', 'yes', 'begin', 'ok', 'okay', 'sure', 'hello', 'hi', 'go', 'yep', 'yeah'];
    return words.some(w => startKeywords.includes(w));
  }
  return false;
}
