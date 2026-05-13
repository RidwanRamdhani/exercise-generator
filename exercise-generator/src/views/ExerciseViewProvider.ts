import * as vscode from 'vscode';

// ── Interface hasil generate dari LLM ────────────────────────────────────────
// Sesuaikan field ini nanti saat LLM sudah diimplementasikan.
// Field bertanda (?) berarti opsional — mungkin belum tersedia di semua model.
export interface GeneratedExercise {
  id: number;

  // Info soal
  title: string;
  topic: string;                              // keyword yang dipakai user
  difficulty: 'Easy' | 'Medium' | 'Hard';

  // Konten soal
  problem_statement: string;
  example: string;                            // format: "Input: ...\nOutput: ..."

  // Kode
  function_stub: string;                      // hanya header + pass, tanpa solusi
  test_cases: string[];                       // array of assert statement strings

  // Metadata generate (opsional)
  shot?: string;                              // "0-shot" | "1-shot" | dst.
  filters_applied?: string[];                 // filter yang dipakai
}

export class ExerciseViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'exerciseView';
  private _view?: vscode.WebviewView;
  private _exercises: GeneratedExercise[] = [];
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

  // ── Public API: dipanggil dari exerciseGenerator.ts ──────────────────────
  // Nanti saat LLM sudah ada, panggil addGeneratedExercise() dengan data nyata.
  // Untuk sekarang addDummyExercise() dipakai sebagai placeholder.

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
        shot: '2-shot',
        filters_applied: ['Testcase Check', 'Difficulty Check'],
      },
      {
        title: 'Count Frequency',
        topic: 'Dictionary',
        difficulty: 'Medium',
        problem_statement:
          'Write a Python function that takes a list of integers and returns a dictionary where keys are the integers and values are their frequencies in the list.',
        example: 'Input  : [1, 2, 2, 3, 3, 3]\nOutput : {1: 1, 2: 2, 3: 3}',
        function_stub: 'def count_frequency(input_list):\n    # TODO: Implement this function\n    pass',
        test_cases: [
          'assert count_frequency([1, 2, 2, 3, 3, 3]) == {1: 1, 2: 2, 3: 3}',
          'assert count_frequency([]) == {}',
          'assert count_frequency([5]) == {5: 1}',
        ],
        shot: '3-shot',
        filters_applied: ['Testcase Check', 'Difficulty Check'],
      },
    ];

    const dummy = dummies[(this._counter) % dummies.length];
    this.addGeneratedExercise(dummy);
  }

  // ── Format ke editor — sama persis dengan DatabaseViewProvider ────────────
  private _sendToEditor(id: number) {
    const ex = this._exercises.find(e => e.id === id);
    if (!ex) { return; }

    const testCases = ex.test_cases.join('\n');

    const content =
      `"""\n` +
      `Title        : ${ex.title}\n` +
      `Topic        : ${ex.topic}\n` +
      `Difficulty   : ${ex.difficulty}\n` +
      (ex.shot            ? `Shot         : ${ex.shot}\n`                        : '') +
      (ex.filters_applied ? `Filters      : ${ex.filters_applied.join(', ')}\n`  : '') +
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

  function checkLayout() {
    $body.classList.toggle('horizontal', window.innerWidth > window.innerHeight * 1.5);
  }
  checkLayout();
  window.addEventListener('resize', checkLayout);

  vscode.postMessage({ type: 'ready' });

  window.addEventListener('message', ({ data }) => {
    if (data.type === 'update') { render(data.exercises); }
  });

  $list.addEventListener('click', (e) => {
    const btnArrow = e.target.closest('.btn-arrow');
    if (btnArrow) {
      e.stopPropagation();
      vscode.postMessage({ type: 'sendToEditor', id: parseInt(btnArrow.dataset.send) });
      return;
    }

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

      return \`
<div class="card">
  <div class="card-head\${isCollapsed ? ' collapsed' : ''}" data-id="\${ex.id}">
    <span class="chevron codicon codicon-chevron-down"></span>
    <span class="card-title">EXERCISE \${ex.id}</span>
    <button class="btn-arrow codicon codicon-arrow-up" data-send="\${ex.id}" title="Send to Editor"></button>
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