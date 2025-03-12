/**
 * Default prompt template for the AI Assistant feature
 * This prompt instructs Claude to analyze code in a structured format with Markdown
 */
export const DEFAULT_AI_ASSISTANT_PROMPT = `Analyze the provided code and explain it in detail:

Provide a thorough explanation covering:
- What the code does
- How it works
- Any important concepts or patterns used
- Key functions, classes, or variables

Format your explanation using Markdown with:
- Clear headings for major sections
- Bullet points for key points
- Code blocks with proper syntax highlighting (use \`\`\`[language] for code blocks)
- Bold or italic text for emphasis when helpful

Be thorough but clear in your explanation. Include relevant code snippets in your explanation when helpful.

\`\`\`
{selected_text}
\`\`\``;

/**
 * Clears the {selected_text} placeholder in the prompt template
 * and replaces it with the actual selected text
 *
 * @param template The prompt template
 * @param selectedText The text to insert into the template
 * @returns The processed prompt with the selected text inserted
 */
export function processPromptTemplate(
  template: string,
  selectedText: string,
): string {
  return template.replace('{selected_text}', selectedText);
}

/** TODO: why do we have two different messages? */
export const systemMsgForFollowUpInInsightChatInAnthropicService = "Initial code analysis context";
export const systemMsgForFollowUpInInsightChatInAIAssistantUI = "Initial code snippet and insight for context";

export const systemMsgForChatFromSelection = 'Chat started from code selection'
export const systemMsgForConversationContentStart = 'conversation context';