import * as vscode from 'vscode';
import { DatabaseService, SeedExercise } from '../services/DatabaseService';

export class DatabaseViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'databaseView';
  private _view?: vscode.WebviewView;

  // Kunci sekarang adalah nama topik, bukan difficulty
  private _exercisesByTopic: Record<string, SeedExercise[]> = {};
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

    await this._loadExercises();

    webviewView.webview.html = this._getHtml(webviewView.webview);
  }

  private async _loadExercises() {
    try {
      console.log('[DatabaseView] Loading exercises...');
      const all = await this._db.getAllExercises();
      console.log('[DatabaseView] Received', all.length, 'exercises from DB');

      if (all.length === 0) {
        vscode.window.showWarningMessage(
          'Database is empty. Ensure Python backend has tinydb installed and db.json is populated.'
        );
      }

      // Kelompokkan berdasarkan topic; jika tidak ada topic, masukkan ke "General"
      const grouped: Record<string, SeedExercise[]> = {};
      for (const ex of all) {
        const topic = ex.topic?.trim() || 'General';
        if (!grouped[topic]) {
          grouped[topic] = [];
        }
        grouped[topic].push(ex);
      }

      // Urutkan exercise dalam setiap topik: easy → intermediate → hard
      const diffOrder: Record<string, number> = { easy: 0, intermediate: 1, hard: 2 };
      for (const topic of Object.keys(grouped)) {
        grouped[topic].sort(
          (a, b) => (diffOrder[a.difficulty] ?? 0) - (diffOrder[b.difficulty] ?? 0)
        );
      }

      this._exercisesByTopic = grouped;
    } catch (err: any) {
      console.error('[DatabaseView] Error loading exercises:', err);
      vscode.window.showErrorMessage(`Failed to load database: ${err.message}`);
      this._exercisesByTopic = {};
    }
  }

  private _sendToEditor(id: number) {
    let ex: SeedExercise | undefined;
    for (const list of Object.values(this._exercisesByTopic)) {
      ex = list.find(e => e.id === id);
      if (ex) { break; }
    }
    if (!ex) { return; }

    const firstLine = ex.solution.split('\n')[0];
    const funcStub = `${firstLine}\n    # TODO: Implement this function\n    pass`;

    // Assert langsung (tanpa komentar), diletakkan di bawah function stub
    const testCases = (ex.test_cases || []).join('\n');

    const difficultyLabel =
      ex.difficulty === 'easy' ? 'Easy' :
      ex.difficulty === 'intermediate' ? 'Medium' : 'Hard';

    const content =
      `"""\n` +
      `Title        : ${ex.title}\n` +
      `Topic        : ${ex.topic || 'General'}\n` +
      `Difficulty   : ${difficultyLabel}\n` +
      `Type         : ${ex.type || 'N/A'}\n` +
      `Keywords     : ${(ex.keywords || []).join(', ')}\n\n` +
      `Problem:\n${ex.problem_statement}\n\n` +
      `Example:\n${ex.example || ''}\n` +
      `"""\n\n` +
      `${funcStub}\n\n\n` +
      `# Test Cases\n${testCases}`;

    vscode.workspace
      .openTextDocument({ content, language: 'python' })
      .then((doc) => vscode.window.showTextDocument(doc, vscode.ViewColumn.One));
  }

  private _update() {
    this._view?.webview.postMessage({
      type: 'update',
      topics: this._exercisesByTopic
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

  /* ── Toolbar ── */
  #toolbar {
    padding: 6px 8px;
    border-bottom: 1px solid var(--vscode-panel-border);
    display: flex;
    align-items: center;
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
  #toolbar-label {
    font-size: 11px;
    opacity: 0.7;
    margin-left: auto;
  }

  /* ── Scrollable content ── */
  #content {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 4px 0;
  }

  /* ── Topic section ── */
  .section {
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .section:last-child { border-bottom: none; }

  .section-header {
    display: flex;
    align-items: center;
    padding: 6px 8px;
    cursor: pointer;
    user-select: none;
    gap: 6px;
    font-weight: 700;
    font-size: 12px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    background: var(--vscode-sideBarSectionHeader-background,
                    var(--vscode-list-hoverBackground));
    position: sticky;
    top: 0;
    z-index: 1;
  }
  .section-header:hover {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }

  /* Topic icon pill */
  .topic-icon {
    width: 20px;
    height: 20px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 700;
    flex-shrink: 0;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }

  .section-count {
    font-size: 11px;
    opacity: 0.7;
    margin-left: auto;
    padding: 1px 7px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-radius: 10px;
  }

  .chevron {
    font-size: 13px;
    transition: transform .15s;
    opacity: 0.8;
  }
  .collapsed .chevron { transform: rotate(-90deg); }

  /* ── Exercise list ── */
  .exercise-list { display: flex; flex-direction: column; }
  .exercise-list.hidden { display: none; }

  .exercise-card {
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
  }
  .exercise-card:last-child { border-bottom: none; }

  /* Card header row */
  .card-head {
    display: flex;
    align-items: center;
    padding: 5px 6px 5px 20px;
    cursor: pointer;
    user-select: none;
    gap: 5px;
  }
  .card-head:hover { background: var(--vscode-list-hoverBackground); }

  .card-title {
    flex: 1;
    font-size: 12px;
    pointer-events: none;
    line-height: 1.4;
  }

  /* Difficulty badge – compact, right-aligned */
  .badge {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 3px;
    font-weight: 600;
    flex-shrink: 0;
    opacity: 0.9;
  }
  .badge-easy   { background: #388e3c; color: #fff; }
  .badge-medium { background: #f57c00; color: #fff; }
  .badge-hard   { background: #c62828; color: #fff; }

  /* Send-to-editor arrow button */
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
    opacity: 0.65;
    font-size: 14px;
    padding: 0;
    flex-shrink: 0;
  }
  .btn-arrow:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground);
  }
  .btn-arrow * { pointer-events: none; }

  /* Expanded card body */
  .card-body {
    padding: 6px 10px 10px 34px;
    font-size: 12px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  .card-body.hidden { display: none; }
  .card-body b { opacity: 0.85; }
</style>
</head>
<body>

<div id="toolbar">
  <button class="toolbar-btn codicon codicon-sync" title="Refresh" id="btnRefresh"></button>
  <span id="toolbar-label">Database Exercises</span>
</div>

<div id="content">
  <div style="padding:16px;opacity:0.5;font-size:12px;">Loading…</div>
</div>

<script>
  const vscode = acquireVsCodeApi();
  const $content = document.getElementById('content');

  /* ── Toolbar ── */
  document.getElementById('btnRefresh').addEventListener('click', () => {
    vscode.postMessage({ type: 'refresh' });
  });

  /* ── Message handler ── */
  window.addEventListener('message', ({ data }) => {
    if (data.type === 'update') { render(data.topics); }
  });

  /* Signal ready */
  vscode.postMessage({ type: 'ready' });

  /* ── Delegated click handler ── */
  $content.addEventListener('click', (e) => {
    /* Send-to-editor button */
    const btnArrow = e.target.closest('.btn-arrow');
    if (btnArrow) {
      e.stopPropagation();
      vscode.postMessage({ type: 'sendToEditor', id: parseInt(btnArrow.dataset.send) });
      return;
    }

    /* Toggle exercise card body */
    const head = e.target.closest('.card-head');
    if (head) {
      const id = head.dataset.id;
      const body = id ? document.getElementById('body-' + id) : null;
      if (body) {
        head.classList.toggle('open');
        body.classList.toggle('hidden');
      }
      return;
    }

    /* Toggle topic section */
    const sectionHeader = e.target.closest('.section-header');
    if (sectionHeader) {
      const list = sectionHeader.nextElementSibling;
      if (list && list.classList.contains('exercise-list')) {
        sectionHeader.classList.toggle('collapsed');
        list.classList.toggle('hidden');
      }
    }
  });

  /* ── Helpers ── */
  function escapeHtml(str) {
    if (!str) { return ''; }
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Ambil huruf pertama topik sebagai ikon
  function topicInitial(topic) {
    return escapeHtml((topic || '?').charAt(0).toUpperCase());
  }

  function diffBadge(difficulty) {
    if (difficulty === 'easy')         { return '<span class="badge badge-easy">Easy</span>'; }
    if (difficulty === 'intermediate') { return '<span class="badge badge-medium">Med</span>'; }
    if (difficulty === 'hard')         { return '<span class="badge badge-hard">Hard</span>'; }
    return '';
  }

  /* ── Render ── */
  function render(topics) {
    try {
      if (!topics || Object.keys(topics).length === 0) {
        $content.innerHTML =
          '<div style="padding:16px;opacity:0.5;font-size:12px;">No exercises found.</div>';
        return;
      }

      // Urutkan topik secara alfabetis; "General" selalu di akhir
      const sortedTopics = Object.keys(topics).sort((a, b) => {
        if (a === 'General') { return 1; }
        if (b === 'General') { return -1; }
        return a.localeCompare(b);
      });

      let html = '';

      for (const topic of sortedTopics) {
        const list = topics[topic] || [];
        if (list.length === 0) { continue; }

        const sectionId = 'section-' + topic.replace(/\\s+/g, '-');
        const listId    = 'list-'    + topic.replace(/\\s+/g, '-');

        html += \`
          <div class="section">
            <div class="section-header" id="\${sectionId}">
              <span class="topic-icon">\${topicInitial(topic)}</span>
              <span class="codicon codicon-chevron-down chevron"></span>
              <span>\${escapeHtml(topic)}</span>
              <span class="section-count">\${list.length}</span>
            </div>
            <div class="exercise-list" id="\${listId}">
        \`;

        for (const ex of list) {
          const testCasesPreview = (ex.test_cases || [])
            .map(tc => escapeHtml(tc))
            .join('\\n');
          const solutionPreview = escapeHtml(ex.solution || '');

          html += \`
            <div class="exercise-card">
              <div class="card-head" data-id="\${ex.id}">
                <span class="card-title">\${escapeHtml(ex.title)}</span>
                \${diffBadge(ex.difficulty)}
                <button class="btn-arrow codicon codicon-arrow-up"
                        data-send="\${ex.id}"
                        title="Send to Editor"></button>
              </div>
              <div class="card-body hidden" id="body-\${ex.id}"><b>Problem:</b>
\${escapeHtml(ex.problem_statement)}

<b>Example:</b>
\${escapeHtml(ex.example || 'N/A')}

<b>Test Cases:</b>
\${testCasesPreview}

<b>Solution:</b>
\${solutionPreview}
              </div>
            </div>
          \`;
        }

        html += \`
            </div>
          </div>
        \`;
      }

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