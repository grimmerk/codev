/**
 * ai-assistant-ui.tsx
 *
 * This component provides an enhanced version of the AI Assistant interface with:
 * 1. Advanced markdown rendering for AIAssistant's responses (including code blocks)
 * 2. Better styling and layout for the insight part
 * 3. Chat interface for continued conversation with AIAssistant
 */

import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import * as ReactDOM from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import remarkGfm from 'remark-gfm';
import { detectLanguage } from './language-detector';
import { AIAssistantUIMode } from './utility';
import { systemMsgForChatFromSelection, systemMsgForConversationContentStart, systemMsgForFollowUpInInsightChatInAIAssistantUI } from "./ai-assistant-prompt"

const aiAssistantName = 'Liho';

const firstAssistantMsg = `Hi, I'm ${aiAssistantName}! 👋 How can I help you today? Feel free to ask me anything or paste your code here.`;

// Styles for the AI Assistant UI
const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as 'column',
    height: '100vh',
    width: '100vw',
    backgroundColor: '#2d2d2d',
    color: '#f8f8f2',
    fontFamily: 'Arial, sans-serif',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '10px 15px',
    backgroundColor: '#1a1a1a',
    borderBottom: '1px solid #3a3a3a',
  },
  title: {
    margin: 0,
    fontSize: '16px',
    fontWeight: 'bold' as 'bold',
  },
  closeButton: {
    background: 'none',
    border: 'none',
    color: '#f8f8f2',
    fontSize: '16px',
    cursor: 'pointer',
    padding: '0 5px',
  },
  codeSection: {
    padding: '15px',
    borderBottom: '1px solid #3a3a3a',
    maxHeight: '55%', // Dramatically increased from 35% to 55% for better code visibility
    overflow: 'auto',
  },
  divider: {
    height: '1px',
    backgroundColor: '#3a3a3a',
    margin: '0 15px',
  },
  insightSection: {
    padding: '15px',
    flex: 1, // Takes all available space
    height: 'calc(100% - 120px)', // Specifically add height calculation to use all remaining space
    overflow: 'auto',
    position: 'relative' as 'relative',
  },
  insight: {
    margin: 0,
    lineHeight: '1.5',
    color: '#f8f8f2',
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    fontSize: '14px',
  },
  loading: {
    display: 'flex',
    alignItems: 'center',
    color: '#a8a8a8',
  },
  loadingIndicator: {
    display: 'inline-block',
    width: '8px',
    height: '16px',
    backgroundColor: '#a8a8a8',
    marginLeft: '5px',
    animation: 'blink 1s step-end infinite',
  },
  // Chat interface styles
  chatContainer: {
    display: 'flex',
    flexDirection: 'column' as 'column',
    height: 'calc(100% - 60px)', // Adjust for header
    backgroundColor: '#252525',
    flex: 1,
  },
  chatInputContainer: {
    borderTop: '1px solid #3a3a3a',
    padding: '15px',
    position: 'sticky' as 'sticky',
    bottom: 0,
    backgroundColor: '#252525',
    zIndex: 10,
    width: '100%',
    boxSizing: 'border-box' as 'border-box',
    marginTop: '10px',
  },
  chatInput: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
  },
  textInput: {
    flex: 1,
    backgroundColor: '#2d2d2d',
    border: '1px solid #3a3a3a',
    borderRadius: '4px',
    color: '#f8f8f2',
    padding: '10px',
    fontSize: '14px',
    outline: 'none',
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    resize: 'none' as 'none',
    minHeight: '24px',
    maxHeight: '150px',
    overflow: 'auto',
  },
  sendButton: {
    backgroundColor: '#4a4a4a',
    border: 'none',
    borderRadius: '4px',
    color: '#f8f8f2',
    marginLeft: '10px',
    padding: '10px 15px',
    cursor: 'pointer',
    fontSize: '14px',
    whiteSpace: 'nowrap' as 'nowrap',
  },
  chatMessages: {
    padding: '15px 15px 20px 15px', // Added more padding at bottom
    flex: 1,
    overflow: 'auto',
    display: 'flex',
    flexDirection: 'column' as 'column',
    marginBottom: '10px', // Add margin to ensure content isn't cut off
  },
  messageContainer: {
    marginBottom: '15px',
    display: 'flex',
    flexDirection: 'column' as 'column',
    maxWidth: '100%',
  },
  userMessage: {
    alignSelf: 'flex-end' as 'flex-end',
    backgroundColor: '#3a3a3a',
    color: '#f8f8f2',
    padding: '8px 12px',
    borderRadius: '12px 12px 0 12px',
    maxWidth: '90%',
    width: 'fit-content' as 'fit-content',
    marginBottom: '5px',
    wordBreak: 'break-word' as 'break-word',
  },
  assistantMessage: {
    alignSelf: 'flex-start' as 'flex-start',
    backgroundColor: '#424242',
    color: '#f8f8f2',
    padding: '8px 12px',
    borderRadius: '12px 12px 12px 0',
    maxWidth: '98%', // Slightly smaller to ensure no content is cut off at the edge
    width: 'fit-content' as 'fit-content',
    marginBottom: '5px',
    wordBreak: 'break-word' as 'break-word',
    overflow: 'hidden' as 'hidden',
  },
  messageSender: {
    fontSize: '12px',
    color: '#a8a8a8',
    marginBottom: '5px',
  },
  // Conversation selection dropdown and menu styles
  conversationSelector: {
    display: 'flex',
    alignItems: 'center',
    marginRight: '10px',
    position: 'relative' as 'relative',
  },
  conversationButton: {
    backgroundColor: '#3a3a3a',
    border: 'none',
    borderRadius: '4px',
    color: '#f8f8f2',
    padding: '5px 10px',
    cursor: 'pointer',
    fontSize: '13px',
    display: 'flex',
    alignItems: 'center',
  },
  conversationMenu: {
    position: 'absolute' as 'absolute',
    top: '30px',
    right: '0',
    backgroundColor: '#2d2d2d',
    border: '1px solid #3a3a3a',
    borderRadius: '4px',
    zIndex: 100,
    width: '280px',
    maxHeight: '400px',
    overflow: 'auto',
    boxShadow: '0 4px 8px rgba(0, 0, 0, 0.3)',
  },
  conversationMenuItem: {
    padding: '8px 12px',
    borderBottom: '1px solid #3a3a3a',
    cursor: 'pointer',
    fontSize: '13px',
    transition: 'background-color 0.2s',
    display: 'flex',
    flexDirection: 'column' as 'column',
  },
  conversationMenuItemHover: {
    backgroundColor: '#3a3a3a',
  },
  conversationMenuTitle: {
    fontSize: '13px',
    fontWeight: 'bold' as 'bold',
    marginBottom: '3px',
    overflow: 'hidden' as 'hidden',
    textOverflow: 'ellipsis' as 'ellipsis',
    whiteSpace: 'nowrap' as 'nowrap',
  },
  conversationMenuDate: {
    fontSize: '11px',
    color: '#a8a8a8',
  },
  conversationMenuCreate: {
    padding: '10px 12px',
    fontWeight: 'bold' as 'bold',
    backgroundColor: '#424242',
    textAlign: 'center' as 'center',
  },
  conversationLoading: {
    padding: '10px 12px',
    textAlign: 'center' as 'center',
    color: '#a8a8a8',
    fontSize: '13px',
  },
};

// Use @speed-highlight/core to detect programming language
// This will provide more accurate language detection for the input code display
const getDefaultLanguage = (code: string): string => {
  if (!code || code.trim().length === 0) {
    return 'javascript'; // Default for empty code
  }

  try {
    // detectLanguage returns language ID or null if not detected
    const detectedLang = detectLanguage(code);
    console.debug('Detected language:', detectedLang);

    // Map detected language to react-syntax-highlighter supported language
    const langMap: Record<string, string> = {
      js: 'javascript',
      jsx: 'jsx',
      ts: 'typescript',
      tsx: 'tsx',
      py: 'python',
      rb: 'ruby',
      go: 'go',
      java: 'java',
      cpp: 'cpp',
      c: 'c',
      cs: 'csharp',
      php: 'php',
      rs: 'rust',
      swift: 'swift',
      kt: 'kotlin',
      sh: 'bash',
      html: 'html',
      css: 'css',
      sass: 'sass',
      scss: 'scss',
      md: 'markdown',
      json: 'json',
      yaml: 'yaml',
      xml: 'xml',
      sql: 'sql',
    };

    return detectedLang && langMap[detectedLang]
      ? langMap[detectedLang]
      : 'javascript';
  } catch (error) {
    console.error('Error detecting language:', error);
    return 'javascript'; // Fallback
  }
};

// Define types for conversation structures
interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: Date;
  conversationId?: string; // Reference to parent conversation
}

interface Conversation {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  sourceCode?: string;
  codeLanguage?: string;
  isFromCode: boolean;
  initialMode: string;
  messages: Message[];
}

const AIAssistantApp: React.FC = () => {
  const [code, setCode] = useState<string>('');
  const codeRef = useRef(code);
  useEffect(() => {
    codeRef.current = code;
  }, [code]);

  const [insight, setInsight] = useState<string>('');
  const insightContentRef = useRef(insight);
  useEffect(() => {
    insightContentRef.current = insight;
  }, [insight]);

  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isComplete, setIsComplete] = useState<boolean>(false);
  const insightRef = useRef<HTMLDivElement>(null);
  const chatMessagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Chat state
  const [messages, setMessages] = useState<Message[]>([]);
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const [inputValue, setInputValue] = useState<string>('');

  // Conversation tracking
  const [currentConversationId, setCurrentConversationId] = useState<
    string | null
  >(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [isConversationMenuOpen, setIsConversationMenuOpen] =
    useState<boolean>(false);
  const [isLoadingConversations, setIsLoadingConversations] =
    useState<boolean>(false);
  const conversationMenuRef = useRef<HTMLDivElement>(null);

  // UI mode state - controls what view is shown
  const [uiMode, setUIMode] = useState<AIAssistantUIMode>(
    AIAssistantUIMode.INSIGHT_CHAT,
  );
  const uiModeRef = useRef(uiMode);
  useEffect(() => {
    uiModeRef.current = uiMode;
  }, [uiMode]);

  // For backward compatibility - will be removed once migrated completely
  const [showChat, setShowChat] = useState<boolean>(false);

  // Initial language detection for the input code using our detector
  const [inputLanguage, setInputLanguage] = useState<string>(
    detectLanguage(code),
  );
  // State to track language detected by LLM in its response
  const [detectedLanguage, setDetectedLanguage] = useState<string>('');

  // Update inputLanguage when code changes
  useEffect(() => {
    if (code && code.trim()) {
      const detected = detectLanguage(code);
      setInputLanguage(detected);
      console.log(`Local detection for input code: ${detected}`);
    }
  }, [code]);

  // Auto-scroll chat when messages change or loading state changes
  useEffect(() => {
    if (chatMessagesRef.current && messages.length > 0) {
      // Use setTimeout to ensure DOM is fully updated before scrolling
      setTimeout(() => {
        if (chatMessagesRef.current) {
          chatMessagesRef.current.scrollTop =
            chatMessagesRef.current.scrollHeight;
        }
      }, 50);
    }
  }, [messages, isLoading]);

  // Function to load the most recent conversation when in SMART_CHAT mode
  const loadLatestConversation = async (isFromCode: boolean = false) => {
    try {
      setIsLoadingConversations(true);

      // Skip loading if we're currently creating a new conversation
      // Check both the state and the ref to be extra safe
      if (isCreatingNewConversation || isCreatingNewConversationRef.current) {
        console.log('Skipping loadLatestConversation because we are creating a new conversation');
        setIsLoadingConversations(false);
        return null; // Explicitly return null to indicate no conversation was loaded
      }
      
      // Only load conversation if we're in the right mode
      if (
        uiMode !== AIAssistantUIMode.SMART_CHAT &&
        (!isFromCode || uiMode !== AIAssistantUIMode.INSIGHT_CHAT)
      ) {
        setIsLoadingConversations(false);
        return;
      }

      console.log(`Loading latest conversation (isFromCode: ${isFromCode})`);
      const latestConversation = await (
        window as any
      ).electronAPI.getLatestConversation(isFromCode);

      if (
        latestConversation &&
        latestConversation.messages &&
        latestConversation.messages.length > 0
      ) {
        console.log(`Found conversation - ID: ${latestConversation.id}`);
        console.log(`Title: ${latestConversation.title || 'Untitled'}`);
        console.log(`Message count: ${latestConversation.messages.length}`);

        // Force refresh conversations list to ensure we have the latest data
        if (isConversationMenuOpen) {
          loadRecentConversations();
        } else {
          // Still update the conversations array with this conversation
          // to ensure the title is available for the dropdown button
          setConversations((prevConversations) => {
            // Check if conversation already exists in our list
            const existingIndex = prevConversations.findIndex(
              (c) => c.id === latestConversation.id,
            );

            if (existingIndex >= 0) {
              // Update existing conversation
              const updatedConversations = [...prevConversations];
              updatedConversations[existingIndex] = latestConversation;
              return updatedConversations;
            } else {
              // Add at the beginning
              return [latestConversation, ...prevConversations];
            }
          });
        }

        // Set conversation data
        setMessages(latestConversation.messages);
        setCurrentConversationId(latestConversation.id);

        // If there's a title, we can use it in the UI
        console.log(
          `Loaded conversation: ${latestConversation.id} - ${latestConversation.title || 'Untitled'}`,
        );

        if (isFromCode && latestConversation.sourceCode) {
          setCode(latestConversation.sourceCode);

          // If it has insight (assistant message), mark as complete
          const hasInsight = latestConversation.messages.some(
            (m) => m.role === 'assistant',
          );
          if (hasInsight) {
            const insightMessage = latestConversation.messages.find(
              (m) => m.role === 'assistant',
            );
            if (insightMessage) {
              setInsight(insightMessage.content);
              setIsComplete(true);
            }
          }

          // Set the appropriate UI mode based on the initialMode
          if (latestConversation.initialMode) {
            // Try to restore the original mode if possible
            try {
              const savedMode =
                latestConversation.initialMode as AIAssistantUIMode;
              setUIMode(savedMode);
            } catch (e) {
              console.error('Could not restore UI mode from conversation:', e);
            }
          }
        }

        // Ensure we update the dropdown button text immediately
        return latestConversation;
      } else {
        console.log('No conversation found or empty conversation');

        // If no conversation found, create a default welcome message
        if (uiMode === AIAssistantUIMode.SMART_CHAT) {
          setMessages([
            {
              role: 'assistant',
              content: firstAssistantMsg,
            },
          ]);
          setCurrentConversationId(null);

          // Also ensure that code and insight are cleared for a clean slate
          setCode('');
          setInsight('');
          setIsComplete(false);
        } else if (uiMode === AIAssistantUIMode.INSIGHT_CHAT && isFromCode) {
          // For INSIGHT_CHAT mode with no previous code conversation,
          // if we have code in the state, we should keep it and just ensure
          // there's a message for it
          if (code && code.trim()) {
            setMessages([{ role: 'user', content: code }]);
          } else {
            // Switch to SMART_CHAT if no code is available
            setUIMode(AIAssistantUIMode.SMART_CHAT);
            setMessages([
              {
                role: 'assistant',
                content: firstAssistantMsg,
              },
            ]);
          }
        }
        return null;
      }
    } catch (error) {
      console.error('Error loading latest conversation:', error);

      // Fall back to default welcome message
      if (uiMode === AIAssistantUIMode.SMART_CHAT) {
        setMessages([
          {
            role: 'assistant',
            content: firstAssistantMsg,
          },
        ]);
        setCurrentConversationId(null);
      }
      return null;
    } finally {
      setIsLoadingConversations(false);
    }
  };

  // Define all event handlers outside of useEffect to avoid closure issues

  // 1. * handleCodeToGenerateInsight (update code)
  // 2. handleInsightStart (code -> messages )
  // 3. handleSetUIMode (code -> messages) which would set the code into messages again
  // Handler for receiving code
  const handleCodeToGenerateInsight = (_event: any, receivedCode: string) => {
    console.log(
      'Received code to generate insight, length:',
      receivedCode?.length || 0,
      receivedCode,
    );
    setCode(receivedCode || '');

    // We don't reset messages here anymore - it will be done by the appropriate event handlers
    // depending on the UI mode we're switching to
  };

  // Handler for insight start
  const handleInsightStart = () => {
    // Clear the insight state completely
    setInsight('');
    setIsLoading(true);
    setIsComplete(false);

    // Do not reset messages here for INSIGHT_CHAT mode
    // Store code message in INSIGHT_CHAT mode instead of clearing
    if (
      uiModeRef.current === AIAssistantUIMode.INSIGHT_CHAT &&
      codeRef.current
    ) {
      setMessages([{ role: 'user', content: codeRef.current }]);
    } else if (uiModeRef.current === AIAssistantUIMode.INSIGHT_SPLIT) {
      // Only reset messages in INSIGHT_SPLIT mode
      setMessages([]);
    }
    setShowChat(false);
  };

  // Handler for insight chunks
  const handleInsightChunk = (_event: any, chunk: string) => {
    // If chunk is very large (full insight), just set it directly
    // Otherwise append to existing insight
    if (chunk.length > 1000) {
      setInsight(chunk);
    } else {
      setInsight((prev) => prev + chunk);
    }

    // Auto-scroll in split mode
    if (insightRef.current) {
      insightRef.current.scrollTop = insightRef.current.scrollHeight;
    }

    // In INSIGHT_CHAT mode, update the assistant message if we have one
    if (uiModeRef.current === AIAssistantUIMode.INSIGHT_CHAT) {
      // Find if we already have an assistant message
      const assistantMessageIndex = messagesRef.current.findIndex(
        (msg) => msg.role === 'assistant',
      );

      if (assistantMessageIndex >= 0) {
        // Update existing assistant message
        const updatedMessages = [...messagesRef.current];
        // If it's a full insight, replace
        if (chunk.length > 1000) {
          updatedMessages[assistantMessageIndex].content = chunk;
        } else {
          // Otherwise append
          updatedMessages[assistantMessageIndex].content += chunk;
        }
        setMessages(updatedMessages);
      } else if (messagesRef.current.length > 0) {
        // Add a new assistant message if there's at least a user message
        setMessages([
          ...messagesRef.current,
          { role: 'assistant', content: chunk },
        ]);
      }

      // Ensure chat messages are scrolled to bottom
      setTimeout(() => {
        if (chatMessagesRef.current) {
          chatMessagesRef.current.scrollTop =
            chatMessagesRef.current.scrollHeight;
        }
      }, 50);
    }
  };

  // Utility function to sync conversation details
  const syncConversationWithTitle = async (conversationId: string) => {
    if (!conversationId || !(window as any).electronAPI || !(window as any).electronAPI.getConversation) {
      console.warn(`Cannot sync conversation: invalid ID or API not available. ID: ${conversationId}`);
      return;
    }
    
    try {
      console.log(`[SYNC] Fetching details for conversation: ${conversationId}`);
      const conversation = await (window as any).electronAPI.getConversation(conversationId);
      
      if (!conversation) {
        console.warn(`[SYNC] Failed to get conversation details: ${conversationId}`);
        return;
      }
      
      console.log(`[SYNC] Got conversation: ${conversation.id}, title: ${conversation.title || 'Untitled'}`);
      
      // CRITICAL FIX: Force a redraw by setting a temporary value and then the real one
      // This fixes React's optimization that might skip updates when setting the same value
      setCurrentConversationId(null);
      
      // Set timeout to ensure React processes the null value first
      setTimeout(() => {
        // Now set the real conversation ID
        setCurrentConversationId(conversation.id);
        console.log(`[SYNC] Force updated currentConversationId to: ${conversation.id}`);
        
        // Update conversations list
        setConversations(prevConversations => {
          // First, check if this conversation already exists in our list
          const exists = prevConversations.some(c => c.id === conversation.id);
          
          // Log detailed information
          console.log(`[SYNC] Conversation ${conversation.id} exists in list: ${exists}`);
          console.log(`[SYNC] Conversation title: ${conversation.title || 'Untitled'}`);
          
          if (exists) {
            // Replace the existing conversation
            return prevConversations.map(c => 
              c.id === conversation.id ? conversation : c
            );
          } else {
            // Add it to the beginning
            return [conversation, ...prevConversations];
          }
        });
      }, 10);
      
      return conversation;
    } catch (error) {
      console.error(`[SYNC] Error syncing conversation ${conversationId}:`, error);
    }
  };

  // Handler for insight complete
  const handleInsightComplete = (
    _event: any,
    data: { language?: string; conversationId?: string; isRestored?: boolean } = {},
  ) => {
    setIsLoading(false);
    setIsComplete(true);

    // If we received a conversation ID from the completion, store it and sync it
    if (data && data.conversationId) {
      // Check if this is a restored conversation or a new one
      const isRestoredConversation = data.isRestored === true;
      
      console.log(`Insight completed with ID: ${data.conversationId}, isRestored: ${isRestoredConversation}`);
      
      // IMPORTANT: For new conversations, set a temporary value first to trigger proper re-rendering
      // This ensures the React component recalculates the title
      if (!isRestoredConversation) {
        setCurrentConversationId(null);
        console.log('Temporarily reset conversation ID to null to force UI update');
      }
      
      // Then synchronize with latest data from server - this will update the title
      // Use a slight delay to ensure the server has processed any changes
      setTimeout(() => {
        // Don't use setCurrentConversationId here - use the sync function which handles everything
        syncConversationWithTitle(data.conversationId);
      }, 300); // Longer delay to ensure server has processed everything
      
      // Update our conversations menu if it's open
      if (isConversationMenuOpen) {
        loadRecentConversations();
      }
    }

    // Notify main process that insight is complete
    if (
      (window as any).electronAPI &&
      (window as any).electronAPI.notifyInsightCompleted
    ) {
      (window as any).electronAPI.notifyInsightCompleted(true);
    } else {
      // Fallback if API not available
      try {
        const { ipcRenderer } = require('electron');
        ipcRenderer.send('insight-completed', true);
      } catch (e) {
        console.error('Failed to notify main process of insight completion', e);
      }
    }

    // After insight is complete, initialize messages for chat
    if (codeRef.current && insightContentRef.current) {
      const initialMessages: Message[] = [
        {
          role: 'system',
          content: systemMsgForFollowUpInInsightChatInAIAssistantUI,
        },
        { role: 'user', content: codeRef.current },
        { role: 'assistant', content: insightContentRef.current },
      ];
      setMessages(initialMessages);

      // If we're already in INSIGHT_CHAT mode, make sure messages are visible
      if (uiModeRef.current === AIAssistantUIMode.INSIGHT_CHAT) {
        // Ensure chat messages are scrolled to bottom
        setTimeout(() => {
          if (chatMessagesRef.current) {
            chatMessagesRef.current.scrollTop =
              chatMessagesRef.current.scrollHeight;
          }
        }, 100);
      }
    }
  };

  // Handler for insight errors
  const handleInsightError = (_event: any, error: string) => {
    console.error('Insight error:', error);
    setInsight((prev) => prev + '\n\nError: ' + error);
    setIsLoading(false);
  };

  // Handler for skipping insight (when prompt template is empty)
  const handleSkipInsight = (
    _event: any,
    data: { reason: string; code: string },
  ) => {
    setIsLoading(false);

    // Get the code from the data if provided, or use current code state
    const codeToUse = data?.code || codeRef.current;

    // Switch to INSIGHT_SOURCE_CHAT mode (chat with code as first message, but no LLM request yet)
    setUIMode(AIAssistantUIMode.INSIGHT_SOURCE_CHAT);
    setShowChat(true); // For backward compatibility

    // Initialize chat with code as first message
    if (codeToUse && codeToUse.trim().length > 0) {
      setCode(codeToUse);

      // Create initial message array with system message to ensure proper conversation initialization
      const systemMessage = {
        role: 'system',
        content: systemMsgForChatFromSelection,
      };
      const initialMessages = [
        systemMessage,
        { role: 'user', content: codeToUse },
      ];

      setMessages(initialMessages);

      // Create a placeholder conversation ID to ensure state is ready for chat
      setCurrentConversationId('');

      // The first message will initialize the conversation properly when sent
      // with additionalContext including the sourceCode and INSIGHT_SOURCE_CHAT mode
    }
  };

  // Handler for explicitly setting UI mode
  const handleSetUIMode = (
    _event: any,
    mode: AIAssistantUIMode,
    data: any = {},
  ) => {
    let aiAssistantMode: AIAssistantUIMode;

    console.log(`Setting UI mode to ${mode} with data:`, data);

    if (typeof mode === 'string') {
      // Handle string values (from IPC)
      switch (mode) {
        case AIAssistantUIMode.INSIGHT_SPLIT:
          aiAssistantMode = AIAssistantUIMode.INSIGHT_SPLIT;
          break;
        case AIAssistantUIMode.INSIGHT_CHAT:
          aiAssistantMode = AIAssistantUIMode.INSIGHT_CHAT;
          break;
        case AIAssistantUIMode.INSIGHT_SOURCE_CHAT:
          aiAssistantMode = AIAssistantUIMode.INSIGHT_SOURCE_CHAT;
          break;
        case AIAssistantUIMode.SMART_CHAT:
          aiAssistantMode = AIAssistantUIMode.SMART_CHAT;
          break;
        default:
          // If it's already a valid AIAssistantUIMode string value
          aiAssistantMode = mode as AIAssistantUIMode;
      }
    } else {
      // Handle enum values
      switch (mode) {
        case AIAssistantUIMode.INSIGHT_SPLIT:
          aiAssistantMode = AIAssistantUIMode.INSIGHT_SPLIT;
          break;
        case AIAssistantUIMode.INSIGHT_CHAT:
          aiAssistantMode = AIAssistantUIMode.INSIGHT_CHAT;
          break;
        case AIAssistantUIMode.INSIGHT_SOURCE_CHAT:
          aiAssistantMode = AIAssistantUIMode.INSIGHT_SOURCE_CHAT;
          break;
        case AIAssistantUIMode.SMART_CHAT:
          aiAssistantMode = AIAssistantUIMode.SMART_CHAT;
          break;
        default:
          // If it's already a valid AIAssistantUIMode enum value
          aiAssistantMode = mode as AIAssistantUIMode;
      }
    }

    // Set the UI mode state
    setUIMode((oldValue) => {
      /** NOTE: this is needed to update it soon,
       * otherwise handleInsightStart may read old value since updating take some time */
      uiModeRef.current = aiAssistantMode;

      // Notify main process of mode change
      if (
        (window as any).electronAPI &&
        (window as any).electronAPI.notifyUIMode
      ) {
        (window as any).electronAPI.notifyUIMode(aiAssistantMode);
      } else {
        // Fallback if API not available
        try {
          const { ipcRenderer } = require('electron');
          ipcRenderer.send('ui-mode-changed', aiAssistantMode);
        } catch (e) {
          console.error('Failed to notify main process of UI mode change', e);
        }
      }

      return aiAssistantMode;
    });

    // Update backward compatibility state
    setShowChat(aiAssistantMode !== AIAssistantUIMode.INSIGHT_SPLIT);

    // Flag to determine if we should keep existing messages
    const keepExistingMessages = data && data.keepExistingMessages === true;
    console.log(`keepExistingMessages flag: ${keepExistingMessages}`);

    // If we should keep existing messages and we have a current conversation ID or messages,
    // don't proceed with mode-specific message initialization
    if (
      keepExistingMessages &&
      (currentConversationId || messagesRef.current.length > 0)
    ) {
      console.log(
        'Preserving existing messages due to keepExistingMessages flag',
      );

      // Still handle code and insight fields appropriately for the mode
      if (aiAssistantMode === AIAssistantUIMode.SMART_CHAT) {
        if (codeRef.current) setCode('');
        if (insightContentRef.current) setInsight('');
      }

      // Don't modify messages, but ensure proper scrolling
      // Optimize scroll behavior based on UI mode
      const scrollTimeout =
        aiAssistantMode === AIAssistantUIMode.SMART_CHAT ? 10 : 100;

      setTimeout(() => {
        if (chatMessagesRef.current) {
          chatMessagesRef.current.scrollTop =
            chatMessagesRef.current.scrollHeight;
        }
      }, scrollTimeout);

      return; // Skip the rest of the function
    }

    // Handle each mode specifically
    switch (aiAssistantMode) {
      case AIAssistantUIMode.INSIGHT_SPLIT:
        // Nothing special needed for split mode
        break;

      case AIAssistantUIMode.INSIGHT_CHAT:
        // If we have data with code, use it
        if (data.code) {
          setCode(data.code);

          // Reset conversation ID when handling new code
          // This ensures the button shows "New Chat" until we get
          // a new conversation ID
          if (!data.restoreInsight) {
            setCurrentConversationId(null);
            console.log('Reset conversation ID for new code analysis');
          }
        }

        // Handle restoreInsight flag
        const shouldRestoreInsight = data && data.restoreInsight === true;

        // Initialize with code and insight if we have them
        if (insightContentRef.current && insightContentRef.current.trim()) {
          // If this is a restore operation, mark the insight as complete immediately
          if (shouldRestoreInsight) {
            setIsLoading(false);
            setIsComplete(true);
          }

          setMessages([
            {
              role: 'system',
              content: systemMsgForFollowUpInInsightChatInAIAssistantUI,
            },
            /** current, it should only be code, but adding "data.code ||" for future edge case  */
            { role: 'user', content: data.code || codeRef.current },
            { role: 'assistant', content: insightContentRef.current },
          ]);
        }
        // Otherwise just set the code as the first message and wait for insight
        else if (data.code || codeRef.current) {
          setMessages([
            { role: 'user', content: data.code || codeRef.current },
          ]);
        }
        break;

      case AIAssistantUIMode.INSIGHT_SOURCE_CHAT:
        // Initialize with just the code
        if (data && data.code) {
          setCode(data.code);
          setMessages([{ role: 'user', content: data.code }]);
        } else if (code) {
          setMessages([{ role: 'user', content: codeRef.current }]);
        }
        break;

      case AIAssistantUIMode.SMART_CHAT:
        // Performance optimization: Don't clear state that's already empty
        if (codeRef.current) setCode('');
        if (insightContentRef.current) setInsight('');

        // Only set welcome message if there are no messages or if messages are different
        if (
          messagesRef.current.length === 0 ||
          messagesRef.current.length > 1 ||
          messagesRef.current[0].role !== 'assistant' ||
          !messagesRef.current[0].content.includes(`Hi, I'm ${aiAssistantName}`)
        ) {
          console.log('Setting default welcome message in SMART_CHAT mode');
          // Use a simple welcome message to avoid unnecessary rendering
          setMessages([
            {
              role: 'assistant',
              content: firstAssistantMsg,
            },
          ]);
        }
        break;
    }

    // Optimize scroll behavior based on UI mode
    // Use a shorter timeout for SMART_CHAT mode for better responsiveness
    const scrollTimeout =
      aiAssistantMode === AIAssistantUIMode.SMART_CHAT ? 10 : 100;

    // For SMART_CHAT mode with just welcome message, we can skip scrolling
    if (
      !(
        aiAssistantMode === AIAssistantUIMode.SMART_CHAT &&
        messagesRef.current.length <= 1
      )
    ) {
      setTimeout(() => {
        if (chatMessagesRef.current) {
          chatMessagesRef.current.scrollTop =
            chatMessagesRef.current.scrollHeight;
        }
      }, scrollTimeout);
    }
  };

  // Handler for detected language from code blocks
  const handleDetectedLanguage = (_event: any, language: string) => {
    if (language) {
      setDetectedLanguage(language);
      setInputLanguage(language); // Update the input display language too
    }
  };
  
  // Handler for finding conversation by code content
  // This is used when restoring a window with the same code content
  const handleFindConversationByCode = async (_event: any, codeContent: string) => {
    console.log(`Finding conversation for code: ${codeContent.substring(0, 50)}...`);
    let found = false;
    
    try {
      // Instead of using searchConversations, we'll use a different approach
      // First load recent conversations and then filter them locally
      if ((window as any).electronAPI && (window as any).electronAPI.getConversations) {
        // Get most recent code-based conversations
        const recentConversations = await (window as any).electronAPI.getConversations({
          isFromCode: true,
          limit: 20
        });
        
        // Now find any with matching code
        const matchingConversation = recentConversations.find(c => 
          c.sourceCode && c.sourceCode.includes(codeContent.substring(0, 100))
        );
        
        if (matchingConversation) {
          console.log(`Found matching conversation: ${matchingConversation.id}, title: ${matchingConversation.title || 'Untitled'}`);
          
          // Get full conversation with messages
          if ((window as any).electronAPI.getConversation) {
            const fullConversation = await (window as any).electronAPI.getConversation(matchingConversation.id);
            
            if (fullConversation) {
              console.log(`Loaded full conversation: ${fullConversation.id}, messages: ${fullConversation.messages?.length || 0}`);
              
              // Reset UI state first to force UI update
              setCurrentConversationId(null);
              
              // Set conversation data after a slight delay
              setTimeout(() => {
                // Set conversation data
                setMessages(fullConversation.messages || []);
                setCurrentConversationId(fullConversation.id);
                
                // If it has source code, set it
                if (fullConversation.sourceCode) {
                  setCode(fullConversation.sourceCode);
                }
                
                // For insight-based conversations, set insight content
                const insightMessage = fullConversation.messages.find(
                  (m: any) => m.role === 'assistant' && m.content.length > 100
                );
                
                if (insightMessage) {
                  setInsight(insightMessage.content);
                  setIsComplete(true);
                }
                
                // Make sure this conversation is in our list
                setConversations(prevConversations => {
                  // Check if already exists
                  const exists = prevConversations.some(c => c.id === fullConversation.id);
                  
                  if (!exists) {
                    return [fullConversation, ...prevConversations];
                  }
                  
                  // Replace existing conversation with updated one
                  return prevConversations.map(c => 
                    c.id === fullConversation.id ? fullConversation : c
                  );
                });
                
                // Set UI mode to INSIGHT_CHAT for consistency
                setUIMode(AIAssistantUIMode.INSIGHT_CHAT);
                
                console.log(`Successfully restored conversation: ${fullConversation.title || 'Untitled'}`);
              }, 50);
              
              found = true;
            }
          }
        } else {
          console.log('No matching conversation found in recent conversations');
        }
      }
    } catch (error) {
      console.error('Error finding conversation by code:', error);
    }
    
    // Send result back to main process
    try {
      if ((window as any).ipcRenderer) {
        (window as any).ipcRenderer.send('find-conversation-result', found);
      } else {
        const { ipcRenderer } = require('electron');
        ipcRenderer.send('find-conversation-result', found);
      }
    } catch (e) {
      console.error('Failed to send find-conversation-result', e);
    }
    
    console.log(`Find conversation result: ${found ? 'found' : 'not found'}`);
    return found;
  };

  // Handler for chat response
  const handleChatResponse = async (_event: any, responseText: string) => {
    // Add the assistant's response to the messages
    setMessages((prev) => [
      ...prev,
      { role: 'assistant', content: responseText },
    ]);
    setIsLoading(false);

    // If we have a conversation ID, fetch the updated conversation to get the latest title
    if (currentConversationId) {
      console.log(`Chat response received for conversation ${currentConversationId}`);
      
      // Use our sync function for consistent behavior
      setTimeout(() => {
        syncConversationWithTitle(currentConversationId);
      }, 200);
    } else {
      console.log('No conversation ID yet, will load recent conversations');
      
      // If we don't have a conversation ID yet, wait a moment and then
      // try to load recent conversations to capture any newly created ones
      setTimeout(() => {
        loadRecentConversations();
      }, 500);
    }
  };

  // Handler for conversation saved notification
  const handleConversationSaved = async (
    _event: any,
    data: { conversationId: string },
  ) => {
    if (data && data.conversationId) {
      console.log(`Conversation saved with ID: ${data.conversationId}`);
      
      // Briefly set to null to force UI refresh when it's set again
      setCurrentConversationId(null);
      
      // Use our synchronization function to ensure consistent behavior
      setTimeout(() => {
        syncConversationWithTitle(data.conversationId);
      }, 200);
      
      // Also refresh the conversation list if the menu is open
      if (isConversationMenuOpen) {
        loadRecentConversations();
      }
    }
  };

  // Function to switch to a specific conversation
  const switchToConversation = async (conversationId: string) => {
    try {
      setIsLoadingConversations(true);
      const conversation = await (window as any).electronAPI.getConversation(
        conversationId,
      );

      if (conversation) {
        // Update state with the conversation data
        setMessages(conversation.messages);
        setCurrentConversationId(conversation.id);

        // If it's a code-based conversation, also load the code and insight
        if (conversation.isFromCode && conversation.sourceCode) {
          setCode(conversation.sourceCode);

          // Find the insight message (first assistant message)
          const insightMessage = conversation.messages.find(
            (m) => m.role === 'assistant',
          );
          if (insightMessage) {
            setInsight(insightMessage.content);
            setIsComplete(true);
          }

          // Set the appropriate UI mode based on the initialMode
          if (conversation.initialMode === AIAssistantUIMode.INSIGHT_SPLIT) {
            setUIMode(AIAssistantUIMode.INSIGHT_SPLIT);
          } else {
            setUIMode(AIAssistantUIMode.INSIGHT_CHAT);
          }
        } else {
          // For non-code conversations, switch to SMART_CHAT mode
          setUIMode(AIAssistantUIMode.SMART_CHAT);
        }

        // Close the menu
        setIsConversationMenuOpen(false);
      }
    } catch (error) {
      console.error(
        `Error switching to conversation ${conversationId}:`,
        error,
      );
    } finally {
      setIsLoadingConversations(false);
    }
  };

  // Function to start a new conversation
  // Track if we're creating a new conversation to avoid loading latest conversation
  const [isCreatingNewConversation, setIsCreatingNewConversation] = useState(false);

  // A separate reference to track if we're actively creating a new conversation
  // This needs to persist across renders, unlike the state variable
  const isCreatingNewConversationRef = useRef(false);

  const startNewConversation = () => {
    // Set both the state and ref to indicate we're creating a new conversation
    // The ref will be checked synchronously by other functions
    setIsCreatingNewConversation(true);
    isCreatingNewConversationRef.current = true;
    
    // Clear current conversation state
    console.log('Starting a NEW conversation - preventing auto-load');
    setCurrentConversationId(null);

    // Always switch to SMART_CHAT mode for new conversations
    // This ensures consistent behavior regardless of the current mode
    const wasInInsightMode = uiMode === AIAssistantUIMode.INSIGHT_CHAT || 
                            uiMode === AIAssistantUIMode.INSIGHT_SOURCE_CHAT || 
                            uiMode === AIAssistantUIMode.INSIGHT_SPLIT;
    
    // Clear any previous code and insight content
    if (wasInInsightMode) {
      setCode('');
      setInsight('');
      setIsComplete(false);
    }
    
    // We need to block the automatic load that happens on mode change
    // So we'll set the mode and messages together to ensure consistency
    
    // Set the welcome message first to ensure it's available when mode changes
    setMessages([
      {
        role: 'assistant',
        content: firstAssistantMsg,
      },
    ]);
    
    // Always set to SMART_CHAT mode
    setUIMode(AIAssistantUIMode.SMART_CHAT);
    
    // Force a refresh of the conversations list for the dropdown
    // But don't reset our creating flag until much later
    setTimeout(() => {
      if (isCreatingNewConversationRef.current) {
        loadRecentConversations();
        
        // Reinforce our new message to prevent race conditions
        setMessages([
          {
            role: 'assistant',
            content: firstAssistantMsg,
          },
        ]);
        
        console.log('Still waiting before allowing auto-load again...');
      }
    }, 300);
    
    // Keep the protection active for a longer period
    // This ensures any delayed effects have completed
    setTimeout(() => {
      console.log('Now allowing auto-load again');
      setIsCreatingNewConversation(false);
      isCreatingNewConversationRef.current = false;
    }, 2000); // Much longer delay to ensure we catch all effects

    // Close the menu
    setIsConversationMenuOpen(false);
  };

  // Handler for directly opening chat interface (without code)
  const handleOpenChatInterface = () => {
    // Clear any existing code/insight
    setCode('');
    setInsight('');
    // Show chat interface
    setShowChat(true);

    // Initialize with welcome message if no messages exist
    if (messages.length === 0) {
      setMessages([
        {
          role: 'assistant',
          content: firstAssistantMsg,
        },
      ]);
    }
  };

  // Load the latest conversation when opening the app in SMART_CHAT mode
  useEffect(() => {
    const loadConversation = async () => {
      // Skip loading if we're currently creating a new conversation (check both state and ref)
      if (isCreatingNewConversation || isCreatingNewConversationRef.current) {
        console.log('Skipping uiMode-triggered conversation load because we are creating a new conversation');
        return;
      }
      
      // Also protect against unwanted loading right after creating a new conversation
      // by checking if messagesRef contains just the welcome message
      if (
        messagesRef.current.length === 1 && 
        messagesRef.current[0].role === 'assistant' && 
        messagesRef.current[0].content === firstAssistantMsg
      ) {
        console.log('Skipping load because we already have a welcome message - likely a new conversation');
        return;
      }
      
      if (uiMode === AIAssistantUIMode.SMART_CHAT) {
        const conversation = await loadLatestConversation(false);

        // Immediately update our conversations list with this conversation
        if (conversation) {
          console.log(
            `Initial load - updating conversations with: ${conversation.title}`,
          );
          setConversations((prev) => {
            // Check if conversation already exists in the list
            const exists = prev.some((c) => c.id === conversation.id);
            if (exists) {
              // Replace existing conversation
              return prev.map((c) =>
                c.id === conversation.id ? conversation : c,
              );
            } else {
              // Add new conversation to the beginning
              return [conversation, ...prev];
            }
          });
        }
      } else if (uiMode === AIAssistantUIMode.INSIGHT_CHAT && !code) {
        // If in insight chat mode but no code is set, try to load the latest code-based conversation
        const conversation = await loadLatestConversation(true);

        // Immediately update our conversations list with this conversation
        if (conversation) {
          console.log(
            `Initial code load - updating conversations with: ${conversation.title}`,
          );
          setConversations((prev) => {
            // Check if conversation already exists in the list
            const exists = prev.some((c) => c.id === conversation.id);
            if (exists) {
              // Replace existing conversation
              return prev.map((c) =>
                c.id === conversation.id ? conversation : c,
              );
            } else {
              // Add new conversation to the beginning
              return [conversation, ...prev];
            }
          });
        }
      }
    };

    loadConversation();
  }, [uiMode, isCreatingNewConversation]);

  // Refresh conversations list when currentConversationId changes
  useEffect(() => {
    // If we have a conversation ID AND we're not actively creating a new conversation
    if (currentConversationId && !isCreatingNewConversationRef.current) {
      // Even if the menu is not open, fetch the conversation to update the title
      const fetchConversation = async () => {
        try {
          console.log(
            `Fetching conversation details for ID: ${currentConversationId}`,
          );
          
          // Double-check we're not creating a new conversation to prevent race conditions
          if (isCreatingNewConversationRef.current) {
            console.log('Cancelled fetch because we are now creating a new conversation');
            return;
          }
          
          const conversation = await (
            window as any
          ).electronAPI.getConversation(currentConversationId);
          
          if (conversation && !isCreatingNewConversationRef.current) {
            console.log(`Got conversation details for title: ${conversation.title || 'Untitled'}`);
            
            // Update our local conversations list
            setConversations((prev) => {
              // Check if conversation already exists in the list
              const exists = prev.some((c) => c.id === conversation.id);
              if (exists) {
                // Replace existing conversation
                return prev.map((c) =>
                  c.id === conversation.id ? conversation : c,
                );
              } else {
                // Add new conversation to the beginning
                return [conversation, ...prev];
              }
            });
          }
        } catch (error) {
          console.error(
            `Error fetching conversation details for ${currentConversationId}:`,
            error,
          );
        }
      };

      fetchConversation();

      // Also refresh the full list if menu is open
      if (isConversationMenuOpen) {
        loadRecentConversations();
      }
    }
  }, [currentConversationId]);

  // Function to load recent conversations (for conversation menu)
  const loadRecentConversations = async () => {
    try {
      setIsLoadingConversations(true);
      const recentConversations = await (
        window as any
      ).electronAPI.getConversations({
        take: 10,
        orderBy: { updatedAt: 'desc' },
      });
      setConversations(recentConversations);
    } catch (error) {
      console.error('Error loading recent conversations:', error);
    } finally {
      setIsLoadingConversations(false);
    }
  };

  // Handle clicks outside the conversation menu to close it
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        conversationMenuRef.current &&
        !conversationMenuRef.current.contains(event.target as Node) &&
        isConversationMenuOpen
      ) {
        setIsConversationMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isConversationMenuOpen]);

  // Set up listeners for all the events (once only)
  useEffect(() => {
    // Store all event handlers to remove them on cleanup
    const handlers = {
      'code-to-generate-insight': handleCodeToGenerateInsight,
      'insight-start': handleInsightStart,
      'insight-chunk': handleInsightChunk,
      'insight-complete': handleInsightComplete,
      'insight-error': handleInsightError,
      'skip-insight': handleSkipInsight,
      'detected-language': handleDetectedLanguage,
      'chat-response': handleChatResponse,
      'set-ui-mode': handleSetUIMode,
      // Legacy handlers - keeping for backward compatibility
      'ai-assistant-insight-start': handleInsightStart,
      'ai-assistant-insight-chunk': handleInsightChunk,
      'ai-assistant-insight-complete': handleInsightComplete,
      'ai-assistant-insight-error': handleInsightError,
      'skip-ai-assistant-insight': handleSkipInsight,
    };

    // Register all listeners if API is available
    if ((window as any).electronAPI) {
      // New event names
      if ((window as any).electronAPI.onCodeToGenerateInsight) {
        (window as any).electronAPI.onCodeToGenerateInsight(
          handleCodeToGenerateInsight,
        );
      }
      if ((window as any).electronAPI.onInsightStart) {
        (window as any).electronAPI.onInsightStart(handleInsightStart);
      }
      if ((window as any).electronAPI.onInsightChunk) {
        (window as any).electronAPI.onInsightChunk(handleInsightChunk);
      }
      if ((window as any).electronAPI.onInsightComplete) {
        (window as any).electronAPI.onInsightComplete(handleInsightComplete);
      }
      if ((window as any).electronAPI.onInsightError) {
        (window as any).electronAPI.onInsightError(handleInsightError);
      }
      if ((window as any).electronAPI.onSkipInsight) {
        (window as any).electronAPI.onSkipInsight(handleSkipInsight);
      }

      // Legacy event names - for backward compatibility
      (window as any).electronAPI.onCodeToGenerateInsight(
        handleCodeToGenerateInsight,
      );
      (window as any).electronAPI.onAIAssistantInsightStart(handleInsightStart);
      (window as any).electronAPI.onAIAssistantInsightChunk(handleInsightChunk);
      (window as any).electronAPI.onAIAssistantInsightComplete(
        handleInsightComplete,
      );
      (window as any).electronAPI.onAIAssistantInsightError(handleInsightError);
      (window as any).electronAPI.onSkipInsight(handleSkipInsight);
      (window as any).electronAPI.onDetectedLanguage(handleDetectedLanguage);

      // Chat-related event listeners
      if ((window as any).electronAPI.onChatResponse) {
        (window as any).electronAPI.onChatResponse(handleChatResponse);
      }

      // Handle conversation saved notifications
      if ((window as any).electronAPI.onChatConversationSaved) {
        (window as any).electronAPI.onChatConversationSaved(
          handleConversationSaved,
        );
      }

      // UI mode control
      if ((window as any).electronAPI.onSetUIMode) {
        (window as any).electronAPI.onSetUIMode(handleSetUIMode);
      }

      // Add listener for loading latest conversation
      if ((window as any).electronAPI.onLoadLatestConversation) {
        (window as any).electronAPI.onLoadLatestConversation(() => {
          // When this event is received, load the most recent conversation
          // This ensures we continue where we left off when reopening chat
          loadLatestConversation(false);
        });
      }
      
      // Register handler for finding conversation by code
      if ((window as any).electronAPI.onFindConversationByCode) {
        (window as any).electronAPI.onFindConversationByCode(handleFindConversationByCode);
      }
    } else {
      console.error('electronAPI not available');
    }

    // Cleanup function to remove all event listeners
    return () => {
      if ((window as any).electronAPI) {
        const ipcRenderer = require('electron').ipcRenderer;

        // Remove all listeners
        Object.entries(handlers).forEach(([channel, handler]) => {
          ipcRenderer.removeListener(channel, handler);
        });
      }
    };

    // Empty dependency array ensures this effect runs only once when component mounts
  }, []);

  const closeWindow = () => {
    window.close();
  };

  const handleInputChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    setInputValue(e.target.value);

    // Auto-adjust height for textarea
    if (e.target instanceof HTMLTextAreaElement) {
      // Reset height to auto to properly calculate for new content
      e.target.style.height = 'auto';
      // Set height to minimum of scrollHeight (content height) and 150px (max)
      e.target.style.height = `${Math.min(e.target.scrollHeight, 150)}px`;
    }
  };

  const handleSendMessage = () => {
    if (!inputValue.trim()) return;

    // Add user message to chat, including conversation ID if we have one
    const userMessage: Message = {
      role: 'user',
      content: inputValue,
      conversationId: currentConversationId || undefined,
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, userMessage]);

    // Send message to main process
    if (
      (window as any).electronAPI &&
      (window as any).electronAPI.sendChatMessage
    ) {
      // Prepare full message history with proper metadata
      let messageHistory = [...messages];

      // If we have a conversation ID, add it to a system message for context
      if (currentConversationId) {
        messageHistory = [
          {
            role: 'system',
            content: systemMsgForConversationContentStart,
            conversationId: currentConversationId,
          },
          ...messageHistory,
        ];
      }

      // Add current UI mode for proper conversation saving
      const additionalContext = {
        uiMode: uiModeRef.current,
        conversationId: currentConversationId,
        sourceCode:
          uiModeRef.current === AIAssistantUIMode.INSIGHT_CHAT ||
          uiModeRef.current === AIAssistantUIMode.INSIGHT_SOURCE_CHAT ||
          uiModeRef.current === AIAssistantUIMode.INSIGHT_SPLIT
            ? codeRef.current
            : undefined,
      };

      (window as any).electronAPI.sendChatMessage(
        inputValue,
        messageHistory,
        additionalContext,
      );
      setIsLoading(true);
    } else {
      console.error('sendChatMessage not available');
    }

    // Clear input field
    setInputValue('');

    // Focus input after sending
    if (inputRef.current) {
      inputRef.current.focus();

      // Reset textarea height if applicable
      if (inputRef.current instanceof HTMLTextAreaElement) {
        inputRef.current.style.height = 'auto';
      }
    }
  };

  const handleKeyPress = (
    e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    // If Enter is pressed without Shift, send the message
    // Otherwise allow Enter to create a new line (for textarea)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  // Toggle between UI modes
  const toggleUIMode = () => {
    // If in split mode, switch to chat with insight
    if (uiMode === AIAssistantUIMode.INSIGHT_SPLIT) {
      // If we have an insight, switch to INSIGHT_CHAT
      if (insight && insight.trim()) {
        handleSetUIMode(null, AIAssistantUIMode.INSIGHT_CHAT);
      }
      // If we have code but no insight, switch to INSIGHT_SOURCE_CHAT
      else if (code && code.trim()) {
        handleSetUIMode(null, AIAssistantUIMode.INSIGHT_SOURCE_CHAT, { code });
      }
      // Otherwise switch to SMART_CHAT
      else {
        handleSetUIMode(null, AIAssistantUIMode.SMART_CHAT);
      }
    }
    // Otherwise switch back to split mode
    else {
      handleSetUIMode(null, AIAssistantUIMode.INSIGHT_SPLIT);
    }

    // For backward compatibility
    setShowChat((prev) => !prev);
  };

  // Optimized markdown rendering with memoization for performance
  const renderMarkdown = React.useMemo(() => {
    const renderer = (content: string) => {
      // Fast path for simple welcome message in SMART_CHAT mode
      if (content === firstAssistantMsg) {
        return (
          <p style={{ marginTop: '0.5em', marginBottom: '0.5em' }}>{content}</p>
        );
      }

      // Regular markdown rendering for other content
      return (
        <ReactMarkdown
          children={content}
          remarkPlugins={[remarkGfm]}
          components={{
            code({ node, inline, className, children, ...props }) {
              const match = /language-(\w+)/.exec(className || '');
              return !inline && match ? (
                <SyntaxHighlighter
                  language={match[1]}
                  style={vscDarkPlus as any}
                  PreTag="div"
                  {...props}
                >
                  {String(children).replace(/\n$/, '')}
                </SyntaxHighlighter>
              ) : (
                <code className={className} {...props}>
                  {children}
                </code>
              );
            },
            // Style other markdown elements
            p: ({ children }) => (
              <p style={{ marginTop: '0.5em', marginBottom: '0.5em' }}>
                {children}
              </p>
            ),
            ul: ({ children }) => (
              <ul style={{ paddingLeft: '20px' }}>{children}</ul>
            ),
            ol: ({ children }) => (
              <ol style={{ paddingLeft: '20px' }}>{children}</ol>
            ),
            li: ({ children }) => (
              <li style={{ margin: '0.2em 0' }}>{children}</li>
            ),
            h1: ({ children }) => (
              <h1
                style={{
                  fontSize: '1.5em',
                  marginTop: '0.8em',
                  marginBottom: '0.5em',
                }}
              >
                {children}
              </h1>
            ),
            h2: ({ children }) => (
              <h2
                style={{
                  fontSize: '1.3em',
                  marginTop: '0.8em',
                  marginBottom: '0.5em',
                }}
              >
                {children}
              </h2>
            ),
            h3: ({ children }) => (
              <h3
                style={{
                  fontSize: '1.1em',
                  marginTop: '0.8em',
                  marginBottom: '0.5em',
                }}
              >
                {children}
              </h3>
            ),
            blockquote: ({ children }) => (
              <blockquote
                style={{
                  borderLeft: '4px solid #444',
                  paddingLeft: '10px',
                  margin: '0.5em 0',
                }}
              >
                {children}
              </blockquote>
            ),
          }}
        >
          {content}
        </ReactMarkdown>
      );
    };

    return renderer;
  }, []);

  // Calculate content height based on whether chat is visible
  const getCodeSectionStyle = () => {
    return {}; // Remove fixed height to use the one defined in styles.codeSection
  };

  const getContentHeight = () => {
    return showChat ? { maxHeight: '30%' } : { flex: 1 }; // Use flex: 1 to take remaining space when in split mode
  };

  let title = '';
  if (uiMode === AIAssistantUIMode.INSIGHT_SPLIT) {
    title = 'Insight Split view';
  } else if (uiMode === AIAssistantUIMode.INSIGHT_CHAT) {
    title = 'Insight Chat';
  } else if (uiMode === AIAssistantUIMode.INSIGHT_SOURCE_CHAT) {
    title = 'Chat from Selection';
  } else if (uiMode === AIAssistantUIMode.SMART_CHAT) {
    title = 'Smart Chat';
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={styles.title}>{title}</h2>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          {/* Conversation selector dropdown */}
          {(uiMode === AIAssistantUIMode.SMART_CHAT ||
            uiMode === AIAssistantUIMode.INSIGHT_CHAT ||
            uiMode === AIAssistantUIMode.INSIGHT_SOURCE_CHAT) && (
            <div style={styles.conversationSelector}>
              <button
                style={styles.conversationButton}
                onClick={() => {
                  if (!isConversationMenuOpen) {
                    loadRecentConversations();
                  }
                  setIsConversationMenuOpen(!isConversationMenuOpen);
                }}
              >
                {(() => {
                  // First check if we're creating a new conversation
                  if (!currentConversationId) {
                    return 'New Chat ▾';
                  }

                  // Find current conversation in our list
                  const currentConversation = conversations.find(
                    (c) => c.id === currentConversationId,
                  );
                  
                  // Debug: check if conversation is in the list
                  console.log(`Looking for conversation: ${currentConversationId}`);
                  console.log(`Found in conversations list: ${!!currentConversation}`);
                  console.log(`Has title: ${currentConversation?.title || 'No title'}`);
                  console.log(`Conversations in list: ${conversations.length}`);
                  
                  // Log all conversations to verify the problem
                  console.log('All conversations:');
                  conversations.forEach((c, i) => {
                    console.log(`  [${i}] id: ${c.id}, title: ${c.title || 'Untitled'}`);
                  });
                  
                  if (currentConversation && currentConversation.title) {
                    // If we have the conversation in our list AND it has a title, use it
                    const shortTitle =
                      currentConversation.title.length > 20
                        ? currentConversation.title.substring(0, 18) + '...'
                        : currentConversation.title;
                    return `${shortTitle} ▾`;
                  } else {
                    // Either conversation not in list or no title
                    return 'Current Chat ▾';
                  }
                })()}
              </button>

              {/* Conversation dropdown menu */}
              {isConversationMenuOpen && (
                <div style={styles.conversationMenu} ref={conversationMenuRef}>
                  {/* New conversation option */}
                  <div
                    style={styles.conversationMenuCreate}
                    onClick={startNewConversation}
                  >
                    + New Conversation
                  </div>

                  {/* Loading indicator */}
                  {isLoadingConversations && (
                    <div style={styles.conversationLoading}>
                      Loading conversations...
                    </div>
                  )}

                  {/* Conversation list */}
                  {!isLoadingConversations &&
                    conversations.map((conversation) => (
                      <div
                        key={conversation.id}
                        style={{
                          ...styles.conversationMenuItem,
                          ...(conversation.id === currentConversationId
                            ? styles.conversationMenuItemHover
                            : {}),
                        }}
                        onClick={() => switchToConversation(conversation.id)}
                      >
                        <div style={styles.conversationMenuTitle}>
                          {conversation.title || 'Untitled Conversation'}
                          {conversation.id === currentConversationId &&
                            ' (Current)'}
                        </div>
                        <div style={styles.conversationMenuDate}>
                          {new Date(conversation.updatedAt).toLocaleString()}
                        </div>
                      </div>
                    ))}

                  {/* Empty state */}
                  {!isLoadingConversations && conversations.length === 0 && (
                    <div style={styles.conversationLoading}>
                      No previous conversations
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Hide Split View toggle button in SMART_CHAT mode */}
          {uiMode !== AIAssistantUIMode.SMART_CHAT && (
            <button
              style={{ ...styles.closeButton, marginRight: '5px' }}
              onClick={toggleUIMode}
              title={
                uiMode !== AIAssistantUIMode.INSIGHT_SPLIT
                  ? 'Show Split View'
                  : 'Show Chat'
              }
            >
              {uiMode !== AIAssistantUIMode.INSIGHT_SPLIT ? '↑' : '↓'}
            </button>
          )}
          <button style={styles.closeButton} onClick={closeWindow}>
            ✕
          </button>
        </div>
      </div>

      {uiMode === AIAssistantUIMode.INSIGHT_SPLIT && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            height: 'calc(100vh - 60px)', // Full height minus header
            overflow: 'hidden',
          }}
        >
          {/* Code section */}
          <div
            style={{
              ...styles.codeSection,
              height: 'auto',
              maxHeight: '40%',
              minHeight: '100px',
              flexShrink: 0,
            }}
          >
            <SyntaxHighlighter
              language={inputLanguage}
              style={vscDarkPlus as any}
              customStyle={{
                background: '#1e1e1e',
                marginTop: 0,
                borderRadius: '4px',
                fontSize: '14px',
                lineHeight: '1.5',
                height: 'auto',
              }}
              showLineNumbers={true}
              wrapLines={true}
            >
              {code || '// Waiting for code...'}
            </SyntaxHighlighter>
          </div>

          <div style={styles.divider}></div>

          {/* Insight section - Takes all remaining space */}
          <div
            style={{
              ...styles.insightSection,
              flex: 1, // Take all remaining space
              overflow: 'auto',
              display: 'flex', // Use flex layout
              flexDirection: 'column',
              minHeight: '60%', // At least 60% of the space
            }}
            ref={insightRef}
          >
            <div style={styles.insight}>
              {/* Use the memoized renderer function for INSIGHT_SPLIT mode too */}
              {renderMarkdown(insight.replace(/^LANGUAGE:\s*\w+\s*\n*/i, ''))}

              {isLoading && (
                <div style={styles.loading}>
                  <span>[Generating</span>
                  <span style={styles.loadingIndicator}>▋</span>
                  <span>]</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Chat section - completely replaces insight section when in any chat mode */}
      {uiMode !== AIAssistantUIMode.INSIGHT_SPLIT && (
        <div style={styles.chatContainer}>
          {/* Messages display */}
          <div style={styles.chatMessages} ref={chatMessagesRef}>
            {/* Show all messages including initial code and insight as chat */}
            {messages
              .filter((msg) => msg.role !== 'system')
              .map((msg, index) => (
                <div key={index} style={styles.messageContainer}>
                  <div
                    style={
                      {
                        ...styles.messageSender,
                        textAlign: msg.role === 'user' ? 'right' : 'left',
                      } as any
                    }
                  >
                    {msg.role === 'user' ? 'You' : aiAssistantName}
                  </div>
                  <div
                    style={
                      msg.role === 'user'
                        ? styles.userMessage
                        : styles.assistantMessage
                    }
                  >
                    {msg.role === 'user' ? (
                      // For user messages that contain the original code, use syntax highlighting
                      msg.content === code ? (
                        <SyntaxHighlighter
                          language={inputLanguage}
                          style={vscDarkPlus as any}
                          customStyle={{
                            background: 'transparent',
                            padding: 0,
                            margin: 0,
                            fontSize: '14px',
                            lineHeight: '1.5',
                          }}
                          showLineNumbers={true}
                          wrapLines={true}
                        >
                          {msg.content}
                        </SyntaxHighlighter>
                      ) : (
                        <div style={{ whiteSpace: 'pre-wrap' }}>
                          {msg.content}
                        </div>
                      )
                    ) : (
                      // Invoke the memoized render function with message content
                      renderMarkdown(msg.content)
                    )}
                  </div>
                </div>
              ))}

            {/* only smart chat or chat after 1st insight needs thinking */}
            {isLoading && !(insight && !isComplete) && (
              <div
                style={{ ...styles.messageContainer, alignItems: 'flex-start' }}
              >
                <div style={styles.messageSender}>{aiAssistantName}</div>
                <div style={{ ...styles.assistantMessage, display: 'flex' }}>
                  <span>Thinking</span>
                  <span style={styles.loadingIndicator}>▋</span>
                </div>
              </div>
            )}
          </div>

          {/* Input area - now in a sticky container */}
          <div style={styles.chatInputContainer}>
            <div style={styles.chatInput}>
              <textarea
                ref={inputRef}
                value={inputValue}
                onChange={handleInputChange}
                onKeyPress={handleKeyPress}
                placeholder="Ask a follow-up question... (Shift+Enter for new line)"
                style={styles.textInput}
                disabled={isLoading}
                rows={1}
              />
              <button
                style={styles.sendButton}
                onClick={handleSendMessage}
                disabled={isLoading || !inputValue.trim()}
              >
                Send
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// Initialize the app
document.addEventListener('DOMContentLoaded', () => {
  const root = ReactDOM.createRoot(
    document.getElementById('ai-assistant-root'),
  );
  root.render(<AIAssistantApp />);

  console.log('AIAssistantApp rendered');
});
