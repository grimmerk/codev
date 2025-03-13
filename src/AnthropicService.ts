import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import * as dotenv from 'dotenv';
import { BrowserWindow } from 'electron';
import * as path from 'path';
import {
  DEFAULT_AI_ASSISTANT_PROMPT,
  processPromptTemplate,
  systemMsgForFollowUpInInsightChatInAIAssistantUI,
} from './ai-assistant-prompt';
import { detectLanguage } from './language-detector';
import { AIAssistantUIMode, isDebug } from './utility';

// Load environment variables from .env file
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// Class to handle Anthropic API calls from the main process
export class AnthropicService {
  private anthropic: Anthropic;
  private apiKey: string;
  private customPrompt: string | null = null;
  private codeInsightCache: Map<string, InsightCacheItem> = new Map(); // Cache for insight with prompt used
  private SERVER_URL = 'http://localhost:55688';

  constructor() {
    // Get API key from environment variable
    this.apiKey = process.env.ANTHROPIC_API_KEY || '';

    if (isDebug) {
      console.log(
        'Anthropic API key status:',
        this.apiKey ? 'Found' : 'Missing',
      );
    }

    this.setupClient();
    this.loadSettings();
  }

  // Load settings from database
  private async loadSettings(): Promise<void> {
    try {
      const response = await fetch(`${this.SERVER_URL}/ai-assistant-settings`);
      if (response.ok) {
        const settings = await response.json();

        if (settings) {
          // Update custom prompt if available
          if (settings.customPrompt !== undefined) {
            this.customPrompt = settings.customPrompt;
          }

          // Always update API key regardless of whether it's empty or not
          if (settings.apiKey !== undefined) {
            // This will update even if empty, allowing user to clear the API key
            this.apiKey = settings.apiKey;
            // Fall back to environment variable if empty
            if (this.apiKey === '') {
              this.apiKey = process.env.ANTHROPIC_API_KEY || '';
            }
            this.setupClient(); // Re-initialize client with updated API key
          }
        }
      }
    } catch (error) {
      console.error('Failed to load ai assistant settings:', error);
    }
  }

  // Clear the cache if it gets too large
  private manageCacheSize(): void {
    const MAX_CACHE_SIZE = 50; // Maximum number of entries
    if (this.codeInsightCache.size > MAX_CACHE_SIZE) {
      // Convert to array and keep only the most recent entries
      const entries = Array.from(this.codeInsightCache.entries());
      this.codeInsightCache = new Map(entries.slice(-MAX_CACHE_SIZE / 2)); // Keep half
    }
  }

  // Clear all cache entries - useful when prompt template changes significantly
  public clearCache(): void {
    this.codeInsightCache.clear();
    if (isDebug) {
      console.log('Insight cache cleared');
    }
  }

  private setupClient(): void {
    if (this.apiKey === undefined) {
      console.error(
        'Anthropic API key not found. Please set ANTHROPIC_API_KEY environment variable.',
      );
      return;
    }

    this.anthropic = new Anthropic({
      apiKey: this.apiKey,
    });
  }

  /**
   * Analyze code using Anthropic's Claude API with streaming response
   * @param code The code to analyze
   * @param window The BrowserWindow to send updates to
   */
  public async analyzeCodeToGetInsight(
    code: string,
    window: BrowserWindow,
    options: { isRestored?: boolean } = {},
  ): Promise<void> {
    // Always reload settings to get latest prompt and API key
    await this.loadSettings();

    if (!this.anthropic) {
      window.webContents.send(
        'ai-assistant-insight-error',
        'Anthropic client not initialized - API key missing',
      );
      return;
    }

    try {
      // Check if window is still valid
      if (!window || window.isDestroyed()) {
        console.error('Window is no longer valid');
        return;
      }

      // Start with empty insight - this will reset the UI
      window.webContents.send('ai-assistant-insight-start');

      // Get the prompt template to use
      const promptTemplate = this.customPrompt ?? DEFAULT_AI_ASSISTANT_PROMPT;

      // If prompt template is empty, don't send a request to LLM - user just wants to use the chat interface
      if (promptTemplate.trim() === '') {
        if (isDebug) {
          console.log('Custom prompt is empty - skipping insight request');
        }
        // Send skip-ai-assistant-insight event with the code
        window.webContents.send('skip-ai-assistant-insight', {
          reason: 'Custom prompt template is empty',
          code,
        });
        return;
      }

      // Process the prompt template by replacing {selected_text} with the actual code
      const prompt = processPromptTemplate(promptTemplate, code);

      // Check if we have this code in cache with the same prompt
      const cacheKey = code;
      const cachedItem = this.codeInsightCache.get(cacheKey);

      if (cachedItem && cachedItem.prompt === promptTemplate) {
        if (isDebug) {
          console.log('Using cached insight for code');
          if (cachedItem.language) {
            console.log(
              'Using cached language detection:',
              cachedItem.language,
            );
          }
        }

        // Send the cached insight
        const cachedInsight = cachedItem.insight;

        // If we have cached language info, send it immediately
        if (cachedItem.language) {
          window.webContents.send('detected-language', cachedItem.language);
        }

        // Send the entire insight at once instead of chunking
        // This avoids potential duplication issues with chunking
        window.webContents.send('ai-assistant-insight-chunk', cachedInsight);

        // Signal completion with language info
        window.webContents.send('ai-assistant-insight-complete', {
          language: cachedItem.language,
        });
        return;
      }

      // Accumulate the full insight to save in cache
      let fullInsight = '';

      // Create a streaming message
      const stream = await this.anthropic.messages.create({
        model: 'claude-3-7-sonnet-20250219',
        max_tokens: 4000,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        stream: true,
      });

      // Variables to track code block languages
      let detectedLanguage = '';
      let foundFirstCodeBlock = false;
      let accumulatedText = '';

      // Process the stream
      for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta' && chunk.delta.text) {
          // console.debug('debugging delta:', chunk.delta.text);

          // Accumulate for cache
          fullInsight += chunk.delta.text;

          // Accumulate text to detect language from first code block
          if (!foundFirstCodeBlock) {
            accumulatedText += chunk.delta.text;

            // Check if this chunk contains a code block start with language
            const codeBlockMatch = accumulatedText.match(/```(\w+)/);
            if (codeBlockMatch && codeBlockMatch[1]) {
              detectedLanguage = codeBlockMatch[1].toLowerCase();
              foundFirstCodeBlock = true;

              if (isDebug) {
                console.log(
                  `Detected language from code block: ${detectedLanguage}`,
                );
              }

              // Send a special message to notify about detected language
              window.webContents.send('detected-language', detectedLanguage);
            }
          }

          // Send each chunk to the renderer process - but only if it's not empty
          if (chunk.delta.text.trim().length > 0) {
            window.webContents.send(
              'ai-assistant-insight-chunk',
              chunk.delta.text,
            );
          }
        }
      }

      // console.debug('debugging final fullInsight:', fullInsight);

      // After streaming is complete, send the full insight again
      // This ensures we have a clean, non-duplicated insight in the UI
      window.webContents.send('ai-assistant-insight-chunk', fullInsight);

      if (isDebug) {
        console.log('fullInsight:', fullInsight.substring(0, 200) + '...');
        if (detectedLanguage) {
          console.log('Detected language from code blocks:', detectedLanguage);
        }
      }

      // Store in cache with the prompt used
      this.codeInsightCache.set(code, {
        insight: fullInsight,
        prompt: promptTemplate,
        language: detectedLanguage,
      });
      this.manageCacheSize();

      // Create and save conversation record
      try {
        const title = this.generateTitle(code, fullInsight);

        const conversation = {
          title,
          sourceCode: code,
          codeLanguage: detectedLanguage || detectLanguage(code),
          isFromCode: true,
          initialMode: AIAssistantUIMode.INSIGHT_CHAT,
          messages: [
            {
              role: 'system',
              content: systemMsgForFollowUpInInsightChatInAIAssistantUI,
            },
            {
              role: 'user',
              content: code,
            },
            {
              role: 'assistant',
              content: fullInsight,
            },
          ],
        };

        // Save the conversation to the database via the server
        const response = await axios.post(
          `${this.SERVER_URL}/conversations`,
          conversation,
        );
        const savedConversation = response.data;

        if (isDebug) {
          console.log('Saved conversation:', savedConversation.id);
        }

        // Signal completion with detected language, conversation ID and isRestored flag
        window.webContents.send('ai-assistant-insight-complete', {
          language: detectedLanguage,
          conversationId: savedConversation.id,
          isRestored: options.isRestored || false,
        });
      } catch (error) {
        console.error('Error saving conversation:', error);

        // Still signal completion even if saving failed
        window.webContents.send('ai-assistant-insight-complete', {
          language: detectedLanguage,
        });
      }
    } catch (error) {
      console.error('Error analyzing code:', error);
      window.webContents.send(
        'ai-assistant-insight-error',
        this.apiKey ? 'Error generating insight' : 'API key is missing',
      );
    }
  }

  /**
   * Handle chat messages in the AI Assistant by sending them to Claude API
   * @param message The user's chat message
   * @param window The BrowserWindow to send updates to
   * @param messageHistory The current message history from the UI
   * @param additionalContext Optional context with conversationId, uiMode, etc.
   */
  public async handleChatMessage(
    message: string,
    window: BrowserWindow,
    messageHistory: any[],
    additionalContext?: any,
  ): Promise<void> {
    // Always reload settings to get latest API key
    await this.loadSettings();

    if (!this.anthropic) {
      window.webContents.send(
        'chat-response-error',
        'Anthropic client not initialized - API key missing',
      );
      return;
    }

    try {
      // Check if window is still valid
      if (!window || window.isDestroyed()) {
        console.error('Window is no longer valid');
        return;
      }

      // Signal chat response starting
      window.webContents.send('chat-response-start');

      // Format the message history for Claude API
      // Filter out system messages and transform to Claude's format
      const formattedMessages = messageHistory
        .filter((msg) => msg.role !== 'system')
        .map((msg) => ({
          role: msg.role,
          content: msg.content,
        }));

      // Add the current message
      formattedMessages.push({
        role: 'user',
        content: message,
      });

      // Accumulate the full response to return
      let fullResponse = '';

      // Create a streaming chat message
      const stream = await this.anthropic.messages.create({
        model: 'claude-3-7-sonnet-20250219',
        max_tokens: 4000,
        messages: formattedMessages,
        stream: true,
      });

      // Process the stream
      for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta' && chunk.delta.text) {
          // Accumulate full response
          fullResponse += chunk.delta.text;

          // Send each chunk to the renderer process - but only if it's not empty
          if (chunk.delta.text.trim().length > 0) {
            window.webContents.send('chat-response-chunk', chunk.delta.text);
          }
        }
      }

      // Signal completion
      window.webContents.send('chat-response-complete');

      // Send the full response for the UI to add to its state
      window.webContents.send('chat-response', fullResponse);

      // Save or update conversation record
      try {
        // Determine if this is a new conversation or continuing an existing one
        let existingConversationId = null;
        let isNewConversation = true;

        // First check additionalContext for conversation ID
        if (additionalContext && additionalContext.conversationId) {
          existingConversationId = additionalContext.conversationId;
          isNewConversation = false;
          if (isDebug) {
            console.log(
              `Using conversation ID from additionalContext: ${existingConversationId}`,
            );
          }
        } else {
          // Fall back to checking messageHistory for an existing conversation ID
          const systemMessage = messageHistory.find(
            (msg) => msg.role === 'system' && msg.conversationId,
          );
          if (systemMessage && systemMessage.conversationId) {
            existingConversationId = systemMessage.conversationId;
            isNewConversation = false;
            if (isDebug) {
              console.log(
                `Using conversation ID from systemMessage: ${existingConversationId}`,
              );
            }
          } else {
            if (isDebug) {
              console.log(
                'No existing conversation ID found, creating new conversation',
              );
            }
          }
        }

        // Create updated messages array with the new response
        const updatedMessages = [
          ...messageHistory,
          { role: 'user', content: message },
          { role: 'assistant', content: fullResponse },
        ];

        if (isNewConversation) {
          // Create a new conversation record
          const title = this.generateChatTitle(message, updatedMessages);

          // Determine if this is code-related based on context
          const isFromCode =
            additionalContext &&
            (additionalContext.sourceCode ||
              additionalContext.uiMode === AIAssistantUIMode.INSIGHT_CHAT ||
              additionalContext.uiMode === AIAssistantUIMode.SELECTION_CHAT ||
              additionalContext.uiMode === AIAssistantUIMode.INSIGHT_SPLIT);

          // Get UI mode from context or default to SMART_CHAT
          const initialMode =
            additionalContext && additionalContext.uiMode
              ? additionalContext.uiMode
              : AIAssistantUIMode.SMART_CHAT;

          // Include source code if available
          const sourceCode =
            additionalContext && additionalContext.sourceCode
              ? additionalContext.sourceCode
              : undefined;

          // Detect language if it's code-related
          const codeLanguage =
            isFromCode && sourceCode ? detectLanguage(sourceCode) : undefined;

          const conversation = {
            title,
            isFromCode: !!isFromCode,
            initialMode,
            sourceCode,
            codeLanguage,
            messages: updatedMessages,
          };

          const response = await axios.post(
            `${this.SERVER_URL}/conversations`,
            conversation,
          );
          const savedConversation = response.data;

          if (isDebug) {
            console.log('Saved new chat conversation:', savedConversation.id);
          }

          // Include the conversation ID in the response
          window.webContents.send('chat-conversation-saved', {
            conversationId: savedConversation.id,
          });
        } else {
          // Update existing conversation with new messages
          // Send only the new messages to be added, not the entire message history again
          const response = await axios.put(
            `${this.SERVER_URL}/conversations/${existingConversationId}`,
            {
              updatedAt: new Date(),
              messages: [
                { role: 'user', content: message, timestamp: new Date() },
                {
                  role: 'assistant',
                  content: fullResponse,
                  timestamp: new Date(),
                },
              ],
            },
          );

          if (isDebug) {
            console.log(
              `Updated existing conversation: ${existingConversationId} with new messages`,
            );
          }

          if (isDebug) {
            console.log(
              'Updated existing conversation:',
              existingConversationId,
            );
          }
        }
      } catch (error) {
        console.error('Error saving chat conversation:', error);
        // Continue execution even if saving fails
      }

      if (isDebug) {
        console.log('Chat response sent. Length:', fullResponse.length);
      }
    } catch (error) {
      console.error('Error in chat response:', error);
      window.webContents.send(
        'chat-response-error',
        this.apiKey ? 'Error generating response' : 'API key is missing',
      );
    }
  }

  // Language detection is now handled by the LLM itself

  /**
   * Generate a title for a chat conversation
   * @param latestMessage The latest user message
   * @param messages The full message history
   * @returns A suitable title for the conversation
   */
  private generateChatTitle(latestMessage: string, messages: any[]): string {
    // Use the first user message for the title if it's concise
    const firstUserMessage = messages.find((msg) => msg.role === 'user');
    if (firstUserMessage && firstUserMessage.content) {
      const content = firstUserMessage.content.trim();
      // If it's a short message, use it directly
      if (content.length <= 50) {
        return content;
      }
      // Otherwise, use the first sentence or first few words
      const firstSentence = content.match(/^(.+?)[.!?](?:\s|$)/);
      if (firstSentence && firstSentence[1].trim().length > 0) {
        const title = firstSentence[1].trim();
        return title.length > 50 ? title.substring(0, 47) + '...' : title;
      }

      // Fall back to first few words
      const firstWords = content.split(' ').slice(0, 6).join(' ');
      return firstWords.length > 50
        ? firstWords.substring(0, 47) + '...'
        : firstWords;
    }

    // If no good first message, use the latest message
    if (latestMessage && latestMessage.trim().length > 0) {
      const content = latestMessage.trim();
      return content.length > 50 ? content.substring(0, 47) + '...' : content;
    }

    // Last resort
    return 'Chat Conversation ' + new Date().toLocaleDateString();
  }

  /**
   * Generate a suitable title for a conversation based on code and insight
   * @param code The source code
   * @param insight The generated insight
   * @returns A title string (limited to 50 characters)
   */
  private generateTitle(code: string, insight: string): string {
    // First try to extract a title from the first line of the insight
    // Look for markdown headings or the first sentence
    const headingMatch = insight.match(/^# (.+?)$/m);
    const firstSentenceMatch = insight.match(/^(.+?)[.!?](?:\s|$)/m);

    if (headingMatch && headingMatch[1].trim().length > 0) {
      const title = headingMatch[1].trim();
      return title.length > 50 ? title.substring(0, 47) + '...' : title;
    }

    if (firstSentenceMatch && firstSentenceMatch[1].trim().length > 0) {
      const title = firstSentenceMatch[1].trim();
      return title.length > 50 ? title.substring(0, 47) + '...' : title;
    }

    // If no good title from insight, try to extract from code
    // Look for function/class/method name
    const functionMatch = code.match(/function\s+([a-zA-Z0-9_]+)/);
    const classMatch = code.match(/class\s+([a-zA-Z0-9_]+)/);
    const methodMatch = code.match(
      /(?:public|private|protected|static|async)?\s*([a-zA-Z0-9_]+)\s*\([^)]*\)\s*[\{:]/,
    );

    if (functionMatch) {
      return `Function: ${functionMatch[1]}`.substring(0, 50);
    } else if (classMatch) {
      return `Class: ${classMatch[1]}`.substring(0, 50);
    } else if (methodMatch) {
      return `Method: ${methodMatch[1]}`.substring(0, 50);
    }

    // Fallback: use first line of code
    const firstLineOfCode = code.split('\n')[0].trim();
    if (firstLineOfCode && firstLineOfCode.length > 0) {
      return firstLineOfCode.length > 50
        ? firstLineOfCode.substring(0, 47) + '...'
        : firstLineOfCode;
    }

    // Last resort
    return 'Code Insight ' + new Date().toLocaleDateString();
  }
}

export default new AnthropicService();
