# CodeV Development Guide

## Build Commands

- Electron: `yarn start` (dev), `yarn make` (build), `yarn dev` (with server)
- Extension: `yarn compile` (build), `yarn make` (package)

## Testing

- Server: `yarn test` (unit), `yarn test:e2e` (end-to-end)
- Single test: `yarn test -- -t "test name pattern"`

## Lint/Format

- `yarn lint` (check), `yarn format` (fix)

## Code Style

- Use TypeScript for all components with strict typing
- Use single quotes for strings
- Use trailing commas in arrays/objects
- Prefix interface names with 'I' (e.g., `IWindow`)
- Organize imports alphabetically
- Use async/await for asynchronous operations
- Handle errors with try/catch blocks
- Keep components decoupled with clear interfaces
- Follow the Electron app / Server / Extension architecture

## Current Development Summary

We're working on modifying a code explainer application with the following features:

1. **Main Goal**: Make Cmd+Ctrl+E trigger two functionalities:

   - When text is selected: Auto-copy text, explain code, and show it in chat interface
   - When no text is selected: Open pure chat interface

2. **Issues Fixed**:

   - Added Swift native tool (`CopyTool.swift`) for simulating Cmd+C using macOS Accessibility API
   - Fixed UI mode management with enum `ExplainerUIMode` (SPLIT, CHAT_WITH_EXPLANATION, CHAT_WITH_CODE, PURE_CHAT)
   - Fixed React closure issues by moving event handlers outside useEffect
   - Added multi-line input support with textarea and Shift+Enter for new lines

3. **Key Files Modified**:

   - `/src/utility.ts` - Added ExplainerUIMode enum
   - `/src/main.ts` - Added CopyTool integration, modified keyboard shortcut handling
   - `/src/explainer-ui.tsx` - Modified UI rendering, event handlers, chat interface
   - `/src/preload.ts` - Added new event communication channels
   - `/src/AnthropicService.ts` - Added handling for empty prompt templates
   - `/resources/CopyTool.swift` - Created native tool for keyboard simulation

4. **Current Progress**:

   - We're refactoring explainer-ui.tsx to fix React closure issues
   - Moving event handlers outside useEffect to ensure they always use latest state

5. **Next Steps**:
   - Complete extraction of remaining event handlers in explainer-ui.tsx
   - Properly wire up event registration in useEffect
   - Improve keyboard shortcut handling for hide/show behavior
   - Test functionality across different scenarios

## Recent Performance Optimizations (2025/3/9)

We've implemented several optimizations to improve window opening speed and user experience:

1. **Keyboard Shortcut Changes**:

   - `Cmd+Ctrl+E`: Reads clipboard content and opens explainer window
     - With clipboard content: Shows explanation in CHAT_WITH_EXPLANATION mode
     - Without clipboard content: Shows PURE_CHAT mode
     - Toggles window visibility when pressed repeatedly with same content
   - `Cmd+Ctrl+C`: Direct shortcut to PURE_CHAT mode
     - Toggles visibility if window is already open
   - `Cmd+Ctrl+R`: Original shortcut for main window (unchanged)
   - `Cmd+N`: Creates a new conversation when AI Assistant window is open
     - Works in any UI mode (INSIGHT_SPLIT, INSIGHT_CHAT, SELECTION_CHAT, SMART_CHAT)

2. **Window Management Optimizations**:

   - Pre-initialization: Window is created at app startup (hidden)
   - Immediate visibility: Window shows before mode changes are applied
   - Auto-recreation: Window is automatically recreated after closing
   - State tracking: UI mode and explanation state are preserved

3. **Technical Implementation**:

   - Added state tracking in main process (`lastUIMode`, `lastExplanationCompleted`)
   - Added bidirectional communication between renderer and main process
   - Optimized React rendering with memoization
   - Added smarter timeout handling for UI updates
   - Reduced unnecessary state updates

4. **Known Issues**:

   - Terminal text selection still has some detection issues
   - CHAT_WITH_EXPLANATION mode is inherently slower due to API calls

5. **Future Improvements**:
   - Consider adding preloading for CHAT_WITH_EXPLANATION mode
   - Further optimize rendering performance with React.memo
   - Add loading indicators for better user feedback
   - Consider local caching of explanations for repeated queries

## Pending Tasks and Solutions (2025/3/9)

1. **Console Logs Cleanup**:

- COMPLETED: Removed unnecessary console logs from main.ts and explainer-ui.tsx
- Kept critical logs for debugging purposes (those inside isDebug checks)

2. **Preloading Clarification**:

- Current preloading: Window is created at app startup (via setTimeout in main.ts)
- Loading placeholder: Not currently implemented, but could improve perceived performance
- The placeholder would show immediately while React initializes

3. **ExplainerUIMode Renaming**:

- COMPLETED: Renamed SPLIT to EXPLANATION_SPLIT in utility.ts and explainer-ui.tsx
- Other modes can be renamed for clarity if needed

4. **Scroll Optimization Note**:

- Current condition: `(!(mode === AIAssistantUIMode.SMART_CHAT && messagesRef.current.length <= 1))`
- This skips scrolling for PURE_CHAT with just welcome message
- No chat history implemented yet, but code is future-proofed for when it's added

5. **Settings Window Height**:

- Increase height to ensure "Save" success message is visible

6. **UI Improvements**:

- Remove Split View toggle button in PURE_CHAT mode
- Increase explanation UI height in SPLIT mode
- Improve overall visual design of VS Code project list (app.tsx)

7. **Default Left Click Behavior**:

   - Add option to set PURE_CHAT as default left click behavior

8. **Startup Error**:

   - Current error: "Failed to load explainer settings: TypeError: fetch failed"
   - Likely due to server connection timing - needs graceful handling

9. **Menu Bar Improvements**:

   - Handle MacBook notch design by repositioning important menu items
   - Add keyboard shortcut list to menu bar
   - Consider alternative UI for critical settings

10. **Future Features**:

- Save insight/chat history (as explainer and explanation have been renamed to AI assistant and insight)
- Add Markdown/syntax highlighting in input UI
