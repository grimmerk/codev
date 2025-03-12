// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import axios from 'axios';

function getCurrentWinInfo() {
  const paths = vscode.workspace.workspaceFolders?.map((folder) => {
    const path = folder.uri.path;
    // console.log({ path });
    return path;
  });
  const { workspaceFile } = vscode.workspace;
  const workspace_path = workspaceFile?.path ?? '';
  return {
    paths,
    workspace_path,
  };
}

function postData(deactivate = false) {
  const { paths, workspace_path } = getCurrentWinInfo();

  const url = 'http://localhost:55688/xwins/';
  axios
    .post(url, {
      paths,
      workspace_path,
      deactivate,
    })
    .then(function (response) {
      // console.log(response);
    });
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  // Use the console to output diagnostic information (console.log) and errors (console.error)
  // This line of code will only be executed once when your extension is activated
  // console.log('Congratulations, your extension "xwin" is now active!');

  postData();

  // The command has been defined in the package.json file
  // Now provide the implementation of the command with registerCommand
  // The commandId parameter must match the command field in package.json
  const disposable = vscode.commands.registerCommand('xwin.helloWorld', () => {
    // The code you place here will be executed every time your command is executed
    // Display a message box to the user
    vscode.window.showInformationMessage('Hello World from xwin!');
  });

  context.subscriptions.push(disposable);

  // onDidChangeWorkspaceFolders
  // WorkspaceFoldersChangeEvent ??
  vscode.window.onDidChangeWindowState((e) => {
    // console.log({"state:":e})
    const { paths, workspace_path } = getCurrentWinInfo();
    // console.log("state2,",paths, workspace_path, e  )

    if (e.focused) {
      // console.log('focusd');
      postData();
    } else {
      // console.log('not focusd');
    }

    // e: {focused: false}}
  });

  vscode.workspace.onDidChangeWorkspaceFolders((e) => {
    // console.log(`vscode.workspace.onDidChangeWorkspaceFolders`);
    // console.log({ e })
    postData();

    for (const added of e.added) {
      // {uri:{path}, name}
      // const config = vscode.workspace.getConfiguration('tasks', e.added);
      // console.log(config);
    }
  });

  // disposable = vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
  // 	console.log("1")
  // 	// vscode.window.showInformationMessage(`fired: ${path.basename(e.textEditor.document.fileName)}, ${JSON.stringify(e.visibleRanges)}`);
  // })
  // disposable = vscode.window.onDidChangeTerminalState((e) => {
  // 	console.log("2")
  // 	// vscode.window.showInformationMessage(`fired: ${path.basename(e.textEditor.document.fileName)}, ${JSON.stringify(e.visibleRanges)}`);
  // })
}

// this method is called when your extension is deactivated
export function deactivate() {
  // console.log('deactivate but seems not triggered yet ');
  postData(true);
}
