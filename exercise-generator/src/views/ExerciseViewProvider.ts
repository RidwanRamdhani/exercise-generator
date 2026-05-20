import * as vscode from 'vscode';
import { DatabaseService } from '../services/DatabaseService';

// ── Interface hasil generate dari LLM ────────────────────────────────────────
export interface GeneratedExercise {
  id: number;

  // Info soal
  title: string;
  topic: string;
  difficulty: 'Easy' | 'Medium' | 'Hard';

  // Konten soal
  problem_statement: string;
  example: string;

  // Kode
  function_stub: string;
  test_cases: string[];

  // Solution: disimpan di memori & DB, TIDAK pernah dirender di webview
  solution?: string;

  // Metadata generate
  shot?: string;
  filters_applied?: string[];
}

export class ExerciseViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'exerciseView';
  private _view?: vscode.WebviewView;
  private _exercises: GeneratedExercise[] = [];
  private _counter = 0;
  private _db: DatabaseService;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    db: DatabaseService
  ) {
    this._db = db;
  }

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

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'sendToEditor') {
        this._sendToEditor(msg.id);
      } else if (msg.type === 'saveExercise') {
        await this._handleSave(msg.id, webviewView.webview);
      } else if (msg.type === 'ready') {
        this._update();
      }
    });
  }

  // ── Public API ───────────────────────────────────────────────────────────
  public addGeneratedExercise(data: Omit<GeneratedExercise, 'id'>) {
    this._counter++;
    this._exercises.push({ id: this._counter, ...data });
    this._update();
  }

  /** Placeholder dummy — hapus setelah LLM diimplementasikan */
  public addDummyExercise() {
    const dummies: Omit<GeneratedExercise, 'id'>[] = [
      {
        title: 'Check List Length',
        topic: 'List',
        difficulty: 'Easy',
        problem_statement:
          'Write a Python function that checks whether a given list contains exactly three elements. Return True if the list has exactly three elements, otherwise return False.',
        example: 'Input  : [1, 2, 3]\nOutput : True\n\nInput  : [1, 2]\nOutput : False',
        function_stub: 'def has_three_elements(input_list):\n    # TODO: Implement this function\n    pass',
        test_cases: [
          "assert has_three_elements([1, 2, 3]) == True",
          "assert has_three_elements([1, 2]) == False",
          "assert has_three_elements([]) == False",
          "assert has_three_elements([1, 2, 3, 4]) == False",
        ],
        solution: 'def has_three_elements(input_list):\n    return len(input_list) == 3',
        shot: '1-shot',
        filters_applied: ['Testcase Check'],
      },
      {
        title: 'Count Vowels',
        topic: 'String',
        difficulty: 'Easy',
        problem_statement:
          'Write a Python function count_vowels that takes a single string input parameter and returns the number of vowels (a, e, i, o, u) in the string. The function should ignore the case of the letters.',
        example: 'Input  : "hello"\nOutput : 2\n\nInput  : "AEIOU"\nOutput : 5',
        function_stub: 'def count_vowels(input_string):\n    # TODO: Implement this function\n    pass',
        test_cases: [
          'assert count_vowels("hello") == 2',
          'assert count_vowels("AEIOU") == 5',
          'assert count_vowels("") == 0',
          'assert count_vowels("xyz") == 0',
        ],
        solution: 'def count_vowels(input_string):\n    return sum(1 for c in input_string.lower() if c in "aeiou")',
        shot: '2-shot',
        filters_applied: ['Testcase Check', 'Difficulty Check'],
      },
    ];

    const dummy = dummies[(this._counter) % dummies.length];
    this.addGeneratedExercise(dummy);
  }

  // ── Handler: save exercise ke database ──────────────────────────────────
  private async _handleSave(id: number, webview: vscode.Webview) {
    const ex = this._exercises.find(e => e.id === id);
    if (!ex) { return; }

    // Beri tahu webview agar tombol save masuk state "saving"
    webview.postMessage({ type: 'savingStart', id });

    const result = await this._db.saveGeneratedExercise({
      title:             ex.title,
      topic:             ex.topic,
      difficulty:        ex.difficulty,
      problem_statement: ex.problem_statement,
      example:           ex.example,
      function_stub:     ex.function_stub,
      test_cases:        ex.test_cases,
      solution:          ex.solution ?? '',   // solution tersimpan di DB
      shot:              ex.shot,
      filters_applied:   ex.filters_applied,
    });

    if (result.ok) {
      // Tandai exercise ini sudah tersimpan
      webview.postMessage({ type: 'saveSuccess', id });
      vscode.window.showInformationMessage(`Exercise "${ex.title}" saved to database.`);
    } else {
      webview.postMessage({ type: 'saveError', id });
      vscode.window.showErrorMessage(`Failed to save exercise "${ex.title}".`);
    }
  }

  // ── Format ke editor ─────────────────────────────────────────────────────
  private _sendToEditor(id: number) {
    const ex = this._exercises.find(e => e.id === id);
    if (!ex) { return; }

    const testCases = ex.test_cases.join('\n');

    const content =
      `"""\n` +
      `Title        : ${ex.title}\n` +
      `Topic        : ${ex.topic}\n` +
      `Difficulty   : ${ex.difficulty}\n` +
      (ex.shot            ? `Shot         : ${ex.shot}\n`                       : '') +
      (ex.filters_applied ? `Filters      : ${ex.filters_applied.join(', ')}\n` : '') +
      `\n` +
      `Problem:\n${ex.problem_statement}\n\n` +
      `Example:\n${ex.example}\n` +
      `"""\n\n` +
      `${ex.function_stub}\n\n\n` +
      `# Test Cases\n${testCases}`;

    vscode.workspace
      .openTextDocument({ content, language: 'python' })
      .then(doc => vscode.window.showTextDocument(doc, vscode.ViewColumn.One));
  }

  private _update() {
    const safeExercises = this._exercises.map(({ solution: _solution, ...rest }) => rest);
    this._view?.webview.postMessage({ type: 'update', exercises: safeExercises });
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
    padding: 5px 6px;
    cursor: pointer;
    user-select: none;
    gap: 5px;
  }
  .card-head:hover { background: var(--vscode-list-hoverBackground); }

  .chevron {
    font-size: 13px;
    display: flex;
    align-items: center;
    opacity: 0.8;
    transition: transform .15s;
    pointer-events: none;
  }
  .card-head.collapsed .chevron { transform: rotate(-90deg); }

  .card-title {
    flex: 1;
    font-size: 12px;
    pointer-events: none;
    line-height: 1.4;
  }

  /* ── Tombol aksi di header card ── */
  .btn-icon {
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
    transition: opacity .1s, background .1s;
  }
  .btn-icon:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground);
  }
  .btn-icon * { pointer-events: none; }

  /* State: sudah tersimpan */
  .btn-save.saved {
    opacity: 1;
    color: var(--vscode-terminal-ansiGreen, #4caf50);
    cursor: default;
  }
  .btn-save.saved:hover { background: transparent; }

  /* State: sedang menyimpan */
  .btn-save.saving {
    opacity: 0.5;
    cursor: wait;
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
  .card-body b { opacity: 0.85; }

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

  // Track state per exercise: 'idle' | 'saving' | 'saved'
  const saveState = {};

  function checkLayout() {
    $body.classList.toggle('horizontal', window.innerWidth > window.innerHeight * 1.5);
  }
  checkLayout();
  window.addEventListener('resize', checkLayout);

  vscode.postMessage({ type: 'ready' });

  window.addEventListener('message', ({ data }) => {
    if (data.type === 'update') {
      render(data.exercises);
    } else if (data.type === 'savingStart') {
      setSaveState(data.id, 'saving');
    } else if (data.type === 'saveSuccess') {
      setSaveState(data.id, 'saved');
    } else if (data.type === 'saveError') {
      setSaveState(data.id, 'idle');
    }
  });

  // Update visual state tombol save tanpa re-render seluruh list
  function setSaveState(id, state) {
    saveState[id] = state;
    const btn = document.querySelector('.btn-save[data-save="' + id + '"]');
    if (!btn) { return; }

    btn.classList.remove('saving', 'saved');

    if (state === 'saving') {
      btn.classList.add('saving');
      btn.title = 'Saving...';
      // Ganti icon ke loading (spin via codicon-loading)
      btn.innerHTML = '<i class="codicon codicon-loading codicon-modifier-spin"></i>';
      btn.disabled = true;
    } else if (state === 'saved') {
      btn.classList.add('saved');
      btn.title = 'Saved to database';
      btn.innerHTML = '<i class="codicon codicon-check"></i>';
      btn.disabled = true;
    } else {
      btn.title = 'Save to database';
      btn.innerHTML = '<i class="codicon codicon-save"></i>';
      btn.disabled = false;
    }
  }

  $list.addEventListener('click', (e) => {
    // Tombol Save
    const btnSave = e.target.closest('.btn-save');
    if (btnSave && !btnSave.disabled) {
      e.stopPropagation();
      const id = parseInt(btnSave.dataset.save);
      if (saveState[id] !== 'saved' && saveState[id] !== 'saving') {
        vscode.postMessage({ type: 'saveExercise', id });
      }
      return;
    }

    // Tombol Send to Editor
    const btnArrow = e.target.closest('.btn-arrow');
    if (btnArrow) {
      e.stopPropagation();
      vscode.postMessage({ type: 'sendToEditor', id: parseInt(btnArrow.dataset.send) });
      return;
    }

    // Toggle collapse card
    const head = e.target.closest('.card-head');
    if (head) {
      const id   = head.dataset.id;
      const body = id ? document.getElementById('body-' + id) : null;
      if (body) {
        head.classList.toggle('collapsed');
        body.classList.toggle('hidden');
      }
    }
  });

  function escapeHtml(str) {
    if (!str) { return ''; }
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function render(exercises) {
    if (!exercises.length) {
      $empty.style.display = 'flex';
      $list.style.display  = 'none';
      $list.innerHTML = '';
      return;
    }
    $empty.style.display = 'none';
    $list.style.display  = 'flex';

    // Simpan state collapse sebelum re-render
    const collapsed = new Set(
      [...$list.querySelectorAll('.card-head.collapsed')].map(h => h.dataset.id)
    );

    $list.innerHTML = exercises.map(ex => {
      const isCollapsed = collapsed.has(String(ex.id));
      const testCasesText = (ex.test_cases || []).join('\\n');
      const state = saveState[ex.id] || 'idle';

      // Tentukan tampilan tombol save berdasarkan state
      let saveIcon  = 'codicon-save';
      let saveTitle = 'Save to database';
      let saveClass = '';
      let saveDisabled = '';
      if (state === 'saving') {
        saveIcon    = 'codicon-loading codicon-modifier-spin';
        saveTitle   = 'Saving...';
        saveClass   = 'saving';
        saveDisabled = 'disabled';
      } else if (state === 'saved') {
        saveIcon    = 'codicon-check';
        saveTitle   = 'Saved to database';
        saveClass   = 'saved';
        saveDisabled = 'disabled';
      }

      return \`
<div class="card">
  <div class="card-head\${isCollapsed ? ' collapsed' : ''}" data-id="\${ex.id}">
    <span class="chevron codicon codicon-chevron-down"></span>
    <span class="card-title">EXERCISE \${ex.id}</span>
    <button class="btn-icon btn-save \${saveClass}"
            data-save="\${ex.id}"
            title="\${saveTitle}"
            \${saveDisabled}>
      <i class="codicon \${saveIcon}"></i>
    </button>
    <button class="btn-icon btn-arrow codicon codicon-arrow-up"
            data-send="\${ex.id}"
            title="Send to Editor"></button>
  </div>
  <div class="card-body\${isCollapsed ? ' hidden' : ''}" id="body-\${ex.id}"><b>Topic:</b> \${escapeHtml(ex.topic)}

<b>Problem:</b>
\${escapeHtml(ex.problem_statement)}

<b>Example:</b>
\${escapeHtml(ex.example)}

<b>Code:</b>
\${escapeHtml(ex.function_stub)}

<b>Test Cases:</b>
\${escapeHtml(testCasesText)}
  </div>
</div>\`;
    }).join('');

    $list.scrollLeft = $list.scrollWidth;
  }
</script>
</body>
</html>`;
  }
}