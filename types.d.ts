// Type declarations for packages without TypeScript definitions
declare module 'better-sqlite3';

// Add types for react-syntax-highlighter and react-highlight-words
declare module 'react-syntax-highlighter';
declare module 'react-highlight-words';

// Type for Message objects
interface Message {
  id?: string;
  content: string;
  role: "user" | "assistant" | "system";
  timestamp?: Date;
}

// Type for the insight cache
interface InsightCacheItem {
  insight: string;
  prompt: string;
  language?: string;
}