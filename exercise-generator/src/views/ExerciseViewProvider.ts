import * as vscode from 'vscode';

export class ExerciseViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'exerciseView';
  private _view?: vscode.WebviewView;
  private _exercises: any[] = [];
  private _counter = 0;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getHtml(webviewView.webview);

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this._update();
      }
    });

    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'sendToEditor') {
        this._sendToEditor(msg.id);
      } else if (msg.type === 'ready') {
        this._update();
      }
    });
  }

  public addExercise() {
    this._counter++;

    const dummies = [
      {
        difficulty: 'Easy',
        keywords: ['List', 'Length', 'Conditional'],
        problem:
          'Write a Python function that checks whether a given list contains exactly three elements. Return True if the list has exactly three elements, otherwise return False.',
        example: 'Input  : [1, 2, 3]\nOutput : True\n\nInput  : [1, 2]\nOutput : False',
        code: 'def has_three_elements(input_list):\n    # TODO: Implement this function\n    pass',
      },
      {
        difficulty: 'Easy',
        keywords: ['String', 'Vowel', 'Loop'],
        problem:
          'Write a Python function count_vowels that takes a single string input parameter and returns the number of vowels (a, e, i, o, u) in the string. The function should ignore the case of the letters.',
        example: 'Input  : "hello"\nOutput : 2\n\nInput  : "AEIOU"\nOutput : 5',
        code: 'def count_vowels(input_string):\n    # TODO: Implement this function\n    pass',
      },
      {
        difficulty: 'Medium',
        keywords: ['Dictionary', 'Frequency', 'Loop'],
        problem:
          'Write a Python function that takes a list of integers and returns a dictionary where keys are the integers and values are their frequencies in the list.',
        example: 'Input  : [1, 2, 2, 3, 3, 3]\nOutput : {1: 1, 2: 2, 3: 3}',
        code: 'def count_frequency(input_list):\n    # TODO: Implement this function\n    pass',
      },
    ];

    const dummy = dummies[(this._counter - 1) % dummies.length];
    this._exercises.push({ id: this._counter, ...dummy });
    this._update();
  }

  private _sendToEditor(id: number) {
    const ex = this._exercises.find((e) => e.id === id);
    if (!ex) { return; }

    const content =
      `"""\nDifficulty : ${ex.difficulty}\n` +
      `Keywords   : ${ex.keywords.join(', ')}\n\n` +
      `Problem:\n${ex.problem}\n\n` +
      `Example:\n${ex.example}\n"""\n\n` +
      ex.code;

    vscode.workspace
      .openTextDocument({ content, language: 'python' })
      .then((doc) => vscode.window.showTextDocument(doc, vscode.ViewColumn.One));
  }

  private _update() {
    this._view?.webview.postMessage({ type: 'update', exercises: this._exercises });
  }

  private _getHtml(webview: vscode.Webview): string {
    const codiconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<link rel="stylesheet" href="${codiconUri}"/>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: transparent;
    height: 100vh;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  #empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    opacity: 0.4;
    text-align: center;
    font-size: 12px;
    line-height: 1.6;
  }

  #list {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    display: none;
    flex-direction: column;
  }
  #list::-webkit-scrollbar { width: 4px; }
  #list::-webkit-scrollbar-thumb {
    background: var(--vscode-scrollbarSlider-background);
    border-radius: 2px;
  }

  .card {
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
  }

  .card-head {
    display: flex;
    align-items: center;
    padding: 4px 6px;
    cursor: pointer;
    user-select: none;
    gap: 4px;
  }
  .card-head:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .chevron {
    font-size: 14px;
    display: flex;
    align-items: center;
    opacity: 0.8;
    transition: transform .15s;
    /* pastikan tidak bisa jadi target click sendiri */
    pointer-events: none;
  }
  .card-head.collapsed .chevron {
    transform: rotate(-90deg);
  }

  .card-title {
    flex: 1;
    font-size: 12px;
    pointer-events: none;
  }

  .btn-arrow {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    background: transparent;
    border: none;
    cursor: pointer;
    border-radius: 3px;
    color: var(--vscode-foreground);
    opacity: 0.7;
    font-size: 14px;
    padding: 0;
  }
  .btn-arrow:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground);
  }

  .btn-arrow * {
    pointer-events: none;
  }

  .card-body {
    padding: 6px 10px 10px 22px;
    font-size: 12px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-wrap: break-word;
    overflow-y: auto;
  }
  .card-body.hidden { display: none; }

  /* ── HORIZONTAL MODE ── */
  body.horizontal #list {
    flex-direction: row;
    overflow-x: auto;
    overflow-y: hidden;
    align-items: stretch;
  }
  body.horizontal #list::-webkit-scrollbar { height: 4px; width: 0; }

  body.horizontal .card {
    width: 260px;
    min-width: 260px;
    border-bottom: none;
    border-right: 1px solid var(--vscode-panel-border);
    display: flex;
    flex-direction: column;
  }
  body.horizontal .card-head {
    flex-shrink: 0;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  body.horizontal .card-body {
    flex: 1;
    overflow-y: auto;
    padding: 8px 10px;
  }
  body.horizontal .card-body.hidden { display: block; }
</style>
</head>
<body>

<div id="empty">No exercises yet.<br/>Click <b>More Exercise</b> to generate one.</div>
<div id="list"></div>

<script>
  const vscode = acquireVsCodeApi();
  const $body  = document.body;
  const $empty = document.getElementById('empty');
  const $list  = document.getElementById('list');

  function checkLayout() {
    $body.classList.toggle('horizontal', window.innerWidth > window.innerHeight * 1.5);
  }
  checkLayout();
  window.addEventListener('resize', checkLayout);

  vscode.postMessage({ type: 'ready' });

  window.addEventListener('message', ({ data }) => {
    if (data.type === 'update') render(data.exercises);
  });

  $list.addEventListener('click', (e) => {
  const btnArrow = e.target.closest('.btn-arrow');
  if (btnArrow) {
    e.stopPropagation();
    vscode.postMessage({ type: 'sendToEditor', id: parseInt(btnArrow.dataset.send) });
    return;
  }

  const head = e.target.closest('.card-head');
  if (head && !head.classList.contains('collapsed') || head) {
    const id   = head?.dataset.id;
    const body = id ? document.getElementById('body-' + id) : null;
    if (head && body) {
      head.classList.toggle('collapsed');
      body.classList.toggle('hidden');
    }
  }
});

  function render(exercises) {
    if (!exercises.length) {
      $empty.style.display = 'flex';
      $list.style.display  = 'none';
      $list.innerHTML = '';
      return;
    }
    $empty.style.display = 'none';
    $list.style.display  = 'flex';

    const collapsed = new Set(
      [...$list.querySelectorAll('.card-head.collapsed')].map(h => h.dataset.id)
    );

    $list.innerHTML = exercises.map(ex => {
      const isCollapsed = collapsed.has(String(ex.id));
      return \`
<div class="card">
  <div class="card-head\${isCollapsed ? ' collapsed' : ''}" data-id="\${ex.id}">
    <span class="chevron codicon codicon-chevron-down"></span>
    <span class="card-title">EXERCISE \${ex.id}</span>
    <button class="btn-arrow codicon codicon-arrow-up" data-send="\${ex.id}" title="Send to Editor"></button>
  </div>
  <div class="card-body\${isCollapsed ? ' hidden' : ''}" id="body-\${ex.id}">"""
Difficulty : \${ex.difficulty}
Keywords   : \${ex.keywords.join(', ')}

Problem:
\${ex.problem}

Example:
\${ex.example}
"""

\${ex.code}</div>
</div>\`;
    }).join('');

    $list.scrollLeft = $list.scrollWidth;
  }
</script>
</body>
</html>`;
  }
}