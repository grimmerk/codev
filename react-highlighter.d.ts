// declare module 'react-syntax-highlighter' {
//   import { ComponentType, ReactNode } from 'react';

//   export interface SyntaxHighlighterProps {
//     language?: string;
//     style?: any;
//     children?: string | ReactNode;
//     className?: string;
//     PreTag?: string;
//     customStyle?: any;
//     [key: string]: any;
//   }

//   // Export the named export that the project is using
//   export const Prism: ComponentType<SyntaxHighlighterProps>;

//   // Also export default for compatibility
//   const SyntaxHighlighter: ComponentType<SyntaxHighlighterProps>;
//   export default SyntaxHighlighter;
// }

// declare module 'react-syntax-highlighter/dist/esm/styles/prism' {
//   const vscDarkPlus: any;
//   export { vscDarkPlus };
// }

declare module 'react-syntax-highlighter' {
  import React from 'react';

  interface SyntaxHighlighterProps {
    language?: string;
    style?: any;
    PreTag?: string;
    children: string;
    customStyle?: React.CSSProperties;
    [key: string]: any;
  }

  const SyntaxHighlighter: React.FC<SyntaxHighlighterProps>;

  export default SyntaxHighlighter;

  export const Prism: React.FC<SyntaxHighlighterProps>;
  export const Light: React.FC<SyntaxHighlighterProps>;
}

// declare module 'react-highlight-words' {
//   import { ComponentType } from 'react';

//   export interface HighlighterProps {
//     searchWords: string[];
//     textToHighlight: string;
//     highlightStyle?: any;
//     [key: string]: any;
//   }

//   const Highlighter: ComponentType<HighlighterProps>;
//   export default Highlighter;
// }
