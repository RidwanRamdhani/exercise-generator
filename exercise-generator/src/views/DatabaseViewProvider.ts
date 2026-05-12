import * as vscode from 'vscode';
import { DatabaseService, SeedExercise } from '../services/DatabaseService';

export class DatabaseViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'databaseView';
  private _view?: vscode.WebviewView;
  private _exercisesByDifficulty: Record<string, SeedExercise[]> = { easy: [], intermediate: [], hard: [] };
  private _db: DatabaseService;

  constructor(private readonly _extensionUri: vscode.Uri, db: DatabaseService) {
    this._db = db;
  }

  async resolveWebviewView(webviewView: vscode.WebviewView) {
    console.log('[DatabaseView] resolveWebviewView called');
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    // Set up event handlers BEFORE setting HTML to avoid missing messages
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
      } else if (msg.type === 'refresh') {
        this._loadExercises().then(() => this._update());
      }
    });

    // Load exercises from database first
    await this._loadExercises();

    // Then set HTML (which will trigger webview to load and send 'ready')
    webviewView.webview.html = this._getHtml(webviewView.webview);
  }


  private async _loadExercises() {
    try {
      console.log('[DatabaseView] Loading exercises...');
      const all = await this._db.getAllExercises();
      console.log('[DatabaseView] Received', all.length, 'exercises from DB');
      if (all.length === 0) {
        vscode.window.showWarningMessage('Database is empty. Ensure Python backend has tinydb installed and db.json is populated.');
      }
      const grouped: Record<string, SeedExercise[]> = { easy: [], intermediate: [], hard: [] };
      for (const ex of all) {
        const diff = ex.difficulty || 'easy';
        if (grouped[diff]) {
          grouped[diff].push(ex);
        } else {
          grouped[diff] = [ex];
        }
      }
      console.log('[DatabaseView] Grouped:', JSON.stringify(Object.keys(grouped).map(k => ({key: k, count: grouped[k].length}))));
      this._exercisesByDifficulty = grouped;
    } catch (err: any) {
      console.error('[DatabaseView] Error loading exercises:', err);
      vscode.window.showErrorMessage(`Failed to load database: ${err.message}`);
      this._exercisesByDifficulty = { easy: [], intermediate: [], hard: [] };
    }
  }

  private _sendToEditor(id: number) {
    // Find exercise across all difficulties
    let ex: SeedExercise | undefined;
    for (const list of Object.values(this._exercisesByDifficulty)) {
      ex = list.find(e => e.id === id);
      if (ex) {
        break;
      }
    }
    if (!ex) { return; }

    const content =
      `"""\nTitle        : ${ex.title}\n` +
      `Difficulty   : ${ex.difficulty}\n` +
      `Type         : ${ex.type || 'N/A'}\n` +
      `Keywords     : ${(ex.keywords || []).join(', ')}\n\n` +
      `Problem:\n${ex.problem_statement}\n\n` +
      `Solution:\n${ex.solution}\n\n` +
      `Test Cases:\n${(ex.test_cases || []).join('\n')}\n"""\n\n` +
      ex.solution;

    vscode.workspace
      .openTextDocument({ content, language: 'python' })
      .then((doc) => vscode.window.showTextDocument(doc, vscode.ViewColumn.One));
  }

  private _update() {
    console.log('[DatabaseView] Sending update with difficulties:', JSON.stringify(Object.keys(this._exercisesByDifficulty).map(k => ({key: k, count: this._exercisesByDifficulty[k].length}))));
    console.log('[DatabaseView] Full _exercisesByDifficulty:', this._exercisesByDifficulty);
    this._view?.webview.postMessage({
      type: 'update',
      difficulties: this._exercisesByDifficulty
    });
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

  #toolbar {
    padding: 6px 8px;
    border-bottom: 1px solid var(--vscode-panel-border);
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }

  .toolbar-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    font-size: 12px;
    background: var(--vscode-button-secondaryBackground);
    border: none;
    color: var(--vscode-button-secondaryForeground);
    border-radius: 3px;
    cursor: pointer;
  }
  .toolbar-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  #content {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 4px 0;
  }

  .section {
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .section:last-child {
    border-bottom: none;
  }

  .section-header {
    display: flex;
    align-items: center;
    padding: 6px 8px;
    cursor: pointer;
    user-select: none;
    gap: 4px;
    font-weight: 600;
    font-size: 13px;
    background: var(--vscode-list-hoverBackground);
    position: sticky;
    top: 0;
    z-index: 1;
  }
  .section-header:hover {
    background: var(--vscode-list-activeSelectionBackground);
  }

  .section-count {
    font-size: 11px;
    opacity: 0.7;
    margin-left: auto;
    padding: 0 6px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-radius: 10px;
  }

  .chevron {
    font-size: 14px;
    transition: transform .15s;
  }
  .collapsed .chevron {
    transform: rotate(-90deg);
  }

  .exercise-list {
    display: flex;
    flex-direction: column;
  }
  .exercise-list.hidden {
    display: none;
  }

  .exercise-card {
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
  }
  .exercise-card:last-child {
    border-bottom: none;
  }

  .card-head {
    display: flex;
    align-items: center;
    padding: 4px 6px 4px 18px;
    cursor: pointer;
    user-select: none;
    gap: 4px;
  }
  .card-head:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .card-title {
    flex: 1;
    font-size: 12px;
    pointer-events: none;
  }

  .badge {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 3px;
    margin-right: 4px;
    font-weight: 600;
  }
  .badge-easy { background: #4caf50; color: white; }
  .badge-medium { background: #ff9800; color: white; }
  .badge-hard { background: #f44336; color: white; }

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

  .btn-arrow * { pointer-events: none; }

  .card-body {
    padding: 6px 10px 10px 34px;
    font-size: 12px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-wrap: break-word;
    overflow-y: auto;
  }
  .card-body.hidden { display: none; }
</style>
</head>
<body>

<div id="toolbar">
  <button class="toolbar-btn codicon codicon-sync" title="Refresh" id="btnRefresh"></button>
  <span style="flex:1"></span>
  <span style="font-size:11px; opacity:0.7; align-self:center;">Database Exercises</span>
</div>

<div id="content"></div>

<script>
  const vscode = acquireVsCodeApi();
  const $body = document.body;
  const $content = document.getElementById('content');

  document.getElementById('btnRefresh').addEventListener('click', () => {
    vscode.postMessage({ type: 'refresh' });
  });

  window.addEventListener('message', ({ data }) => {
    if (data.type === 'update') {
      console.log('[DatabaseView Webview] Received update message:', data);
      render(data.difficulties);
    }
  });

  vscode.postMessage({ type: 'ready' });

  $content.addEventListener('click', (e) => {
    const btnArrow = e.target.closest('.btn-arrow');
    if (btnArrow) {
      e.stopPropagation();
      vscode.postMessage({ type: 'sendToEditor', id: parseInt(btnArrow.dataset.send) });
      return;
    }

    const head = e.target.closest('.card-head');
    if (head) {
      const id = head.dataset.id;
      const body = id ? document.getElementById('body-' + id) : null;
      if (head && body) {
        head.classList.toggle('collapsed');
        body.classList.toggle('hidden');
      }
      return;
    }

    const sectionHeader = e.target.closest('.section-header');
    if (sectionHeader) {
      const list = sectionHeader.nextElementSibling;
      if (list && list.classList.contains('exercise-list')) {
        sectionHeader.classList.toggle('collapsed');
        list.classList.toggle('hidden');
      }
    }
  });

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function render(difficulties) {
    try {
      console.log('[DatabaseView Webview] render() called with:', difficulties);
      const order = ['easy', 'intermediate', 'hard'];
      const labels = { easy: 'Easy', intermediate: 'Medium', hard: 'Hard' };
      let html = '';

      for (const key of order) {
        const list = difficulties[key] || [];
        console.log('[DatabaseView Webview] difficulty:', key, 'count:', list.length);
        if (!list || list.length === 0) {
          console.log('[DatabaseView Webview] skipping empty difficulty:', key);
          continue;
        }

        const sectionId = 'section-' + key;
        const listId = 'list-' + key;

        html += \`
          <div class="section">
            <div class="section-header" id="\${sectionId}">
              <span class="chevron codicon codicon-chevron-down"></span>
              <span>\${labels[key]} Exercises</span>
              <span class="section-count">\${list.length}</span>
            </div>
            <div class="exercise-list" id="\${listId}">
          \`;

        for (const ex of list) {
          const badgeClass = key === 'easy' ? 'badge-easy' : key === 'hard' ? 'badge-hard' : 'badge-medium';
          const escapedTitle = escapeHtml(ex.title);
          const escapedProblem = escapeHtml(ex.problem_statement);
          const escapedSolution = escapeHtml(ex.solution);
          const escapedTestCases = (ex.test_cases || []).map(escapeHtml).join('\\n');
          html += \`
            <div class="exercise-card">
              <div class="card-head" data-id="\${ex.id}">
                <span class="card-title">
                  <span class="badge \${badgeClass}">\${labels[key]}</span>
                  \${escapedTitle}
                </span>
                <button class="btn-arrow codicon codicon-arrow-up" data-send="\${ex.id}" title="Send to Editor"></button>
              </div>
              <div class="card-body hidden" id="body-\${ex.id}">
<strong>Problem:</strong>
\${escapedProblem}

<strong>Solution:</strong>
\${escapedSolution}

<strong>Test Cases:</strong>
\${escapedTestCases}
              </div>
            </div>
          \`;
        }

        html += \`
            </div>
          </div>
        \`;
      }

      console.log('[DatabaseView Webview] Final HTML length:', html.length);
      $content.innerHTML = html;
    } catch (err) {
      console.error('[DatabaseView Webview] render error:', err);
    }
  }
</script>
</body>
</html>`;
  }
}
