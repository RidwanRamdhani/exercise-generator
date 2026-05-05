import * as vscode from 'vscode';

export class ExerciseViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'exerciseView';
  private _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true
    };

    webviewView.webview.html = this._getHtml();
  }

  private _getHtml(): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      padding: 10px;
      margin: 0;
      font-family: var(--vscode-font-family);
      font-size: 14px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-wrap: break-word;
      overflow-wrap: break-word;
    }
  </style>
</head>
<body>"""
Difficulty : Easy
Keywords   : List, Length, Conditional

Problem:
Write a Python function that checks whether a given list contains exactly three elements. Return True if the list has exactly three elements, otherwise return False.

Example:
Input  : [1, 2, 3]
Output : True

Input  : [1, 2]
Output : False
"""

def has_three_elements(input_list):
    # TODO: Implement this function
    pass</body>
</html>`;
  }
}
