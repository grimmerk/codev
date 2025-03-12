/**
 * Shared language detection utility for ai-assistant-ui.tsx
 *
 * This provides a simple programming language detection function for syntax highlighting
 * in the UI. This is separate from the language detection done by Claude in its responses,
 * which uses its own AI capabilities to identify languages.
 */

/**
 * Detects the programming language from a code snippet.
 * Uses simple pattern matching to identify common language features.
 *
 * @param code The code to analyze
 * @returns The detected language ID for syntax highlighting
 */
export function detectLanguage(code: string): string {
  if (!code || code.trim().length === 0) {
    return 'javascript'; // Default
  }

  const trimmedCode = code.trim();

  // Python detection - enhanced for better accuracy
  if (
    /def\s+\w+\s*\(/.test(trimmedCode) || // def function_name(
    /^\s*(if|for|while|with)\s+.*:/.test(trimmedCode) || // if/for/while/with ... :
    /^\s*class\s+\w+.*:/.test(trimmedCode) || // class Name:
    /^\s*import\s+[\w.]+/.test(trimmedCode) || // import something
    /^from\s+[\w.]+\s+import/.test(trimmedCode) || // from x import y
    trimmedCode.includes('__init__') || // __init__ method
    trimmedCode.includes('self.') || // self.attribute
    /:$/.test(trimmedCode) || // line ending with :
    /^\s*#\s*.*/.test(trimmedCode) || // Python style comments
    /^\s*print\s*\(/.test(trimmedCode) || // print() function
    /^\s*@\w+/.test(trimmedCode) // Decorators (@decorator)
  ) {
    return 'python';
  }

  // HTML/JSX/TSX detection
  if (
    /<\/?[a-zA-Z][\w.-]*>/.test(trimmedCode) ||
    /^<.*(>[\s\S]*?<\/|(\s*\/>))/.test(trimmedCode)
  ) {
    // Check if it looks like TypeScript + JSX
    if (
      /:\s*(string|number|boolean|any)/.test(trimmedCode) ||
      /interface\s+/.test(trimmedCode) ||
      /type\s+\w+\s*=/.test(trimmedCode)
    ) {
      return 'tsx';
    }

    // Probably JSX
    if (
      trimmedCode.includes('import React') ||
      trimmedCode.includes('useState') ||
      /<[A-Z]\w+/.test(trimmedCode) // React component (capitalized)
    ) {
      return 'jsx';
    }

    // Regular HTML
    return 'html';
  }

  // TypeScript detection
  if (
    /:\s*(string|number|boolean|any)/.test(trimmedCode) ||
    /interface\s+/.test(trimmedCode) ||
    /type\s+\w+\s*=/.test(trimmedCode) ||
    /export\s+(type|interface)/.test(trimmedCode)
  ) {
    return 'typescript';
  }

  // C/C++ detection
  if (
    /#include/.test(trimmedCode) ||
    /int\s+main\s*\(/.test(trimmedCode) ||
    /std::/.test(trimmedCode)
  ) {
    return 'cpp';
  }

  // Java detection
  if (
    /public\s+class/.test(trimmedCode) ||
    /public\s+static\s+void\s+main/.test(trimmedCode) ||
    /import\s+java\./.test(trimmedCode)
  ) {
    return 'java';
  }

  // Go detection
  if (
    /func\s+\w+\s*\(/.test(trimmedCode) ||
    /package\s+\w+/.test(trimmedCode) ||
    /import\s+\(/.test(trimmedCode)
  ) {
    return 'go';
  }

  // Ruby detection
  if (
    /def\s+\w+/.test(trimmedCode) &&
    /end\b/.test(trimmedCode) &&
    !trimmedCode.includes(':')
  ) {
    return 'ruby';
  }

  // SQL detection
  if (
    /SELECT\s+[\w\*]+\s+FROM/i.test(trimmedCode) ||
    /CREATE\s+TABLE/i.test(trimmedCode) ||
    /INSERT\s+INTO/i.test(trimmedCode)
  ) {
    return 'sql';
  }

  // JavaScript (default if nothing else matched)
  return 'javascript';
}
