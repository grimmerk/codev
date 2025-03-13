# CodeV 

Use this to quickly open and switch VS Code projects, and use AI assistant to analyze your code and chat with it instantly. 

## Features

- use shortcut/tray (`Ctrl+Cmd+R`) menu to quickly launch a UI listing recent opened window with different project paths, then select one to open it in VS Code.
- AI Assistant features. CodeV now includes a Code AI Assistant feature powered by Anthropic's Claude AI. This feature allows you to get detailed explanations of code snippets with a simple keyboard shortcut.

### AI Assistant feature

#### Insight Chat mode

1. Select the code or text you want to get analyzed insight in any editor or even on web page.
2. Press `Cmd+C` to copy the selected code to your clipboard.
3. Press `Ctrl+Cmd+E` to open the Code AI Assistant window, which will:
   - Create a floating window with the code from your clipboard
   - Generate an insight using Anthropic Claude
4. The window will display your code and start generating an insight.
5. You can use the input text field to continue the discussion. 
6. You can custom your prompt on the menu bar.

> Note: For a smooth demonstration workflow, make sure to copy your code to the clipboard before triggering the Code AI Assistant with Ctrl+Cmd+E.

**You can click the toggle on the top bar and switch to `Insight Split view mode`**. 

#### Chat from Selection mode

When you customize the prompt as empty, you can still copy your code first, and trigger `Ctrl+Cmd+E`, it would still navigate to the AI Assistant view without triggering insight generation, then you can input your follow-up message to discuss with AI.  

#### Smart chat mode

Trigger `Ctrl+Cmd+C` shortcut to launch pure AI chat mode, just like the Claude or ChatGPT desktop

### Additional Features

- Syntax highlighting for various programming languages
- Streaming explanation that updates in real-time
- Automatic language detection
- Error handling

### How AI Assistant Works

- The Code AI Assistant uses Claude API to generate explanations/insight.
- The API request is made from the main Electron process (not the renderer) for security.
- Explanations/Insights are streamed in real-time for a better user experience.
- The UI is a semi-transparent floating window that can be closed when not needed.

## Dev and package Note

- (not needed anymore) `extension folder:` (for VS Code quick switcher feature) which is for old version (main branch, not the current develop branch, and we have migrated the implemenation to use the vscode/cursor built-in sqlite instead)~~
  - `yarn install`
  - either 
    - `F5 debug` for debugging or 
    - built it and install it. Firstly 
      - install [vsce](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
      - `yarn make`, 
      - `yarn load` (first time) & `yarn reload` to install. 
- ~~electron (desktop app)~~ we have moved the electron stuff in the root level, do following in the `root folder`:
  - `yarn install`
  - DB setup 
    - For the first time or every time db scheme changes, execute `yarn db:migrate` to generate SQLite DB file (`./prisma/dev.db`) and generate TypeScript interface. `yarn db:view` can be used to view DB data.
      - `db:migrate` will also automatically do this part, `yarn install` will also include generated types in node_modules/.prisma/index.d.ts)
  - `yarn start` (not set VS Code debugging yet)
  - package as mac app: `yarn make`. It (Electron part) is about 196MB.
  - build mas build: `yarn make_mas`. Then execute `sh ./sign.sh`.

### Setup of AI Assistant feature

1. Make sure you have an Anthropic API key. You can get one from [Anthropic's website](https://console.anthropic.com/).

2. Set up your API key on the menu bar (-> Setting -> API key setting), or add your API key to the `.env` file in the `electron` directory:

   ```
   ANTHROPIC_API_KEY=your_api_key_here
   ```


### Use VS Code Debugger  

#### To debug main process

In VS Code Run and Debug, choose `Electron: Main Process` to launch and debug.

#### To debug render process, please directly set up breakpoints in the opened dev tool instead, which is what Electron official site recommends

Ref: https://www.electronjs.org/docs/latest/tutorial/application-debugging#renderer-process. 

p.s. We had tried to use VS Code debugger setting for this, but it became invalid after migrating to the new version of Electron.

## Notes about packaging a macOS app

Steps: 
1. Follow [Prepare provisioning profile](https://www.electronjs.org/) section on https://www.electronjs.org/ to get `yourapp.provisionprofile` and download it as `electron/embedded.provisionprofile`.
2. in electron, `yarn make` to generate out folder 

### Server packaging takeway notes 

ref: 
1. https://github.com/prisma/prisma/issues/8449
2. ~~https://github.com/vercel/pkg/issues/1508~~ (we had use vercel/pkg to package server but we have decided to embed server to electron)

