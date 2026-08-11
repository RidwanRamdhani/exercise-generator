import * as vscode from 'vscode';
import {
  DatabaseService,
  ReferenceSolution,
} from '../services/DatabaseService';

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

  // Solution/reference
  // solution masih dipertahankan untuk compatibility dengan kode lama.
  // Reference utama untuk feedback adalah reference_solutions.
  solution?: string;
  reference_solutions?: ReferenceSolution[];

  // Metadata generate
  shot?: string;
  filters_applied?: string[];
}

export class ExerciseViewProvider
  implements vscode.WebviewViewProvider
{
  public static readonly viewType = 'exerciseView';

  private _view?: vscode.WebviewView;

  /**
   * Exercise yang tampil di panel semuanya berasal dari generator.
   *
   * Tidak ada lagi _databaseExercises karena database bukan sumber
   * exercise untuk panel ini.
   */
  private _exercises: GeneratedExercise[] = [];

  private _counter = 0;

  /**
   * DatabaseService tetap digunakan.
   *
   * Bukan untuk mengambil exercise ke panel, tetapi untuk:
   * - menyimpan generated exercise jika user menekan Save
   * - bridge ke Python feedback engine melalui service yang sudah ada
   */
  private _db: DatabaseService;

  /**
   * Mapping:
   *
   * TextDocument -> GeneratedExercise
   *
   * Tujuannya supaya feedbackChecker dapat mengetahui:
   * - exercise apa yang sedang dikerjakan
   * - test cases
   * - reference_solutions
   */
  private _docExerciseMap =
    new WeakMap<vscode.TextDocument, GeneratedExercise>();

  constructor(
    private readonly _extensionUri: vscode.Uri,
    db: DatabaseService
  ) {
    this._db = db;
  }

  // ==========================================================================
  // WEBVIEW
  // ==========================================================================

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html =
      this._getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      async (msg) => {
        if (!msg || typeof msg.type !== 'string') {
          return;
        }

        // --------------------------------------------------------------
        // Send generated exercise ke editor
        // --------------------------------------------------------------
        if (msg.type === 'sendToEditor') {
          this._sendToEditor(msg.id);
          return;
        }

        // --------------------------------------------------------------
        // Save generated exercise ke database
        // --------------------------------------------------------------
        if (msg.type === 'saveExercise') {
          await this._handleSave(
            msg.id,
            webviewView.webview
          );
          return;
        }

        // --------------------------------------------------------------
        // Webview pertama kali siap
        // --------------------------------------------------------------
        if (msg.type === 'ready') {
          this._update();
          return;
        }
      }
    );
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  /**
   * Menambahkan exercise hasil generator ke panel.
   *
   * Semua exercise yang tampil di panel berasal dari method ini.
   */
  public addGeneratedExercise(
    data: Omit<GeneratedExercise, 'id'>
  ) {
    this._counter++;

    const exercise: GeneratedExercise = {
      id: this._counter,
      ...data,
    };

    this._exercises.push(exercise);

    this._update();
  }

  /**
   * Mengambil exercise yang sedang dikerjakan oleh document tertentu.
   *
   * Feedback checker menggunakan method ini untuk mendapatkan:
   * - test_cases
   * - reference_solutions
   * - metadata exercise
   */
  public getExerciseForDocument(
    doc: vscode.TextDocument
  ): GeneratedExercise | undefined {
    return this._docExerciseMap.get(doc);
  }

  // ==========================================================================
  // DUMMY EXERCISE
  // ==========================================================================

  /**
   * Dummy exercise untuk testing lokal.
   *
   * Ini hanya digunakan apabila generator LLM belum dijalankan.
   *
   * Bisa dihapus ketika sistem generator sudah stabil.
   */
  public addDummyExercise() {
    const dummies: Omit<
      GeneratedExercise,
      'id'
    >[] = [
      {
        title: 'Check List Length',

        topic: 'List',

        difficulty: 'Easy',

        problem_statement:
          'Write a Python function that checks whether a given list contains exactly three elements. Return True if the list has exactly three elements, otherwise return False.',

        example:
          'Input  : [1, 2, 3]\n' +
          'Output : True\n\n' +
          'Input  : [1, 2]\n' +
          'Output : False',

        function_stub:
          'def has_three_elements(input_list):\n' +
          '    # TODO: Implement this function\n' +
          '    pass',

        test_cases: [
          'assert has_three_elements([1, 2, 3]) == True',
          'assert has_three_elements([1, 2]) == False',
          'assert has_three_elements([]) == False',
          'assert has_three_elements([1, 2, 3, 4]) == False',
        ],

        solution:
          'def has_three_elements(input_list):\n' +
          '    return len(input_list) == 3',

        reference_solutions: [
          {
            id: 'default',
            technique: 'Direct length comparison',
            solution:
              'def has_three_elements(input_list):\n' +
              '    return len(input_list) == 3',
            explanation:
              'Checks whether the list length is exactly three.',
          },
        ],

        shot: '1-shot',

        filters_applied: [
          'Testcase Check',
        ],
      },

      {
        title: 'Count Vowels',

        topic: 'String',

        difficulty: 'Easy',

        problem_statement:
          'Write a Python function count_vowels that takes a single string input parameter and returns the number of vowels (a, e, i, o, u) in the string. The function should ignore the case of the letters.',

        example:
          'Input  : "hello"\n' +
          'Output : 2\n\n' +
          'Input  : "AEIOU"\n' +
          'Output : 5',

        function_stub:
          'def count_vowels(input_string):\n' +
          '    # TODO: Implement this function\n' +
          '    pass',

        test_cases: [
          'assert count_vowels("hello") == 2',
          'assert count_vowels("AEIOU") == 5',
          'assert count_vowels("") == 0',
          'assert count_vowels("xyz") == 0',
        ],

        solution:
          'def count_vowels(input_string):\n' +
          '    return sum(1 for c in input_string.lower() if c in "aeiou")',

        reference_solutions: [
          {
            id: 'default',
            technique: 'Generator expression with vowel membership',
            solution:
              'def count_vowels(input_string):\n' +
              '    return sum(1 for c in input_string.lower() if c in "aeiou")',
            explanation:
              'Counts characters that belong to the vowel set.',
          },
        ],

        shot: '2-shot',

        filters_applied: [
          'Testcase Check',
          'Difficulty Check',
        ],
      },
    ];

    const dummy =
      dummies[this._counter % dummies.length];

    this.addGeneratedExercise(dummy);
  }

  // ==========================================================================
  // SAVE TO DATABASE
  // ==========================================================================

  /**
   * Menyimpan generated exercise ke database.
   *
   * Catatan:
   * Database bukan sumber exercise panel.
   * Database hanya menjadi persistence/storage ketika user menekan Save.
   */
  private async _handleSave(
    id: number,
    webview: vscode.Webview
  ) {
    const ex = this._exercises.find(
      (exercise) => exercise.id === id
    );

    if (!ex) {
      return;
    }

    webview.postMessage({
      type: 'savingStart',
      id,
    });

    try {
      const result =
        await this._db.saveGeneratedExercise({
          title: ex.title,

          topic: ex.topic,

          difficulty: ex.difficulty,

          problem_statement:
            ex.problem_statement,

          example: ex.example,

          function_stub:
            ex.function_stub,

          test_cases:
            ex.test_cases,

          solution:
            ex.solution ?? '',

          reference_solutions:
            ex.reference_solutions ?? [],

          shot: ex.shot,

          filters_applied:
            ex.filters_applied,
        });

      if (result.ok) {
        webview.postMessage({
          type: 'saveSuccess',
          id,
        });

        vscode.window.showInformationMessage(
          `Exercise "${ex.title}" saved to database.`
        );
      } else {
        webview.postMessage({
          type: 'saveError',
          id,
        });

        vscode.window.showErrorMessage(
          `Failed to save exercise "${ex.title}".`
        );
      }
    } catch (error) {
      console.error(
        '[ExGen] Failed to save exercise:',
        error
      );

      webview.postMessage({
        type: 'saveError',
        id,
      });

      vscode.window.showErrorMessage(
        `Failed to save exercise "${ex.title}".`
      );
    }
  }

  // ==========================================================================
  // SEND TO EDITOR
  // ==========================================================================

  /**
   * Mengirim generated exercise ke editor Python.
   *
   * Tidak ada lagi parameter source:
   *
   * _sendToEditor(id)
   *
   * karena semua exercise berasal dari generator.
   */
  private _sendToEditor(id: number) {
    const ex = this._exercises.find(
      (exercise) => exercise.id === id
    );

    if (!ex) {
      vscode.window.showErrorMessage(
        'Exercise tidak ditemukan.'
      );

      return;
    }

    const testCases =
      ex.test_cases.join('\n');

    const content =
      `"""\n` +
      `Title        : ${ex.title}\n` +
      `Topic        : ${ex.topic}\n` +
      `Difficulty   : ${ex.difficulty}\n` +
      (ex.shot
        ? `Shot         : ${ex.shot}\n`
        : '') +
      (ex.filters_applied
        ? `Filters      : ${ex.filters_applied.join(', ')}\n`
        : '') +
      `\n` +
      `Problem:\n${ex.problem_statement}\n\n` +
      `Example:\n${ex.example}\n` +
      `"""\n\n` +
      `${ex.function_stub}\n\n\n` +
      `# Test Cases\n${testCases}`;

    vscode.workspace
      .openTextDocument({
        content,
        language: 'python',
      })
      .then(
        (doc) => {
          /**
           * Sangat penting:
           *
           * Mapping ini menyimpan exercise object lengkap,
           * termasuk reference_solutions.
           *
           * Feedback checker nanti mengambil data ini
           * menggunakan getExerciseForDocument().
           */
          this._docExerciseMap.set(
            doc,
            ex
          );

          vscode.window.showTextDocument(
            doc,
            vscode.ViewColumn.One
          );
        },
        (error) => {
          console.error(
            '[ExGen] Failed to open exercise document:',
            error
          );

          vscode.window.showErrorMessage(
            'Gagal membuka exercise di editor.'
          );
        }
      );
  }

  // ==========================================================================
  // UPDATE WEBVIEW
  // ==========================================================================

  /**
   * Mengirim hanya generated exercises ke webview.
   *
   * Tidak ada lagi:
   *
   * [...database, ...generated]
   *
   * karena database bukan sumber exercise panel.
   */
  private _update() {
    const exercises =
      this._exercises.map(
        ({
          solution: _solution,
          ...rest
        }) => ({
          ...rest,

          source:
            'generated' as const,
        })
      );

    this._view?.webview.postMessage({
      type: 'update',
      exercises,
    });
  }

  // ==========================================================================
  // HTML / WEBVIEW
  // ==========================================================================

  private _getHtml(
    webview: vscode.Webview
  ): string {
    const codiconUri =
      webview.asWebviewUri(
        vscode.Uri.joinPath(
          this._extensionUri,
          'node_modules',
          '@vscode',
          'codicons',
          'dist',
          'codicon.css'
        )
      );

    return `<!DOCTYPE html>
<html lang="en">

<head>
<meta charset="UTF-8"/>
<meta
  name="viewport"
  content="width=device-width,initial-scale=1.0"
/>

<link
  rel="stylesheet"
  href="${codiconUri}"
/>

<style>

  *,
  *::before,
  *::after {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

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

  #list::-webkit-scrollbar {
    width: 4px;
  }

  #list::-webkit-scrollbar-thumb {
    background:
      var(--vscode-scrollbarSlider-background);
    border-radius: 2px;
  }

  .card {
    border-bottom:
      1px solid var(--vscode-panel-border);

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

  .card-head:hover {
    background:
      var(--vscode-list-hoverBackground);
  }

  .chevron {
    font-size: 13px;

    display: flex;

    align-items: center;

    opacity: 0.8;

    transition:
      transform .15s;

    pointer-events: none;
  }

  .card-head.collapsed
  .chevron {
    transform:
      rotate(-90deg);
  }

  .card-title {
    flex: 1;

    font-size: 12px;

    pointer-events: none;

    line-height: 1.4;
  }

  /* ---------------------------------------------------------
     Button
  --------------------------------------------------------- */

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

    color:
      var(--vscode-foreground);

    opacity: 0.65;

    font-size: 14px;

    padding: 0;

    flex-shrink: 0;

    transition:
      opacity .1s,
      background .1s;
  }

  .btn-icon:hover {
    opacity: 1;

    background:
      var(--vscode-toolbar-hoverBackground);
  }

  .btn-icon * {
    pointer-events: none;
  }

  /* ---------------------------------------------------------
     Save button
  --------------------------------------------------------- */

  .btn-save.saved {
    opacity: 1;

    color:
      var(--vscode-terminal-ansiGreen, #4caf50);

    cursor: default;
  }

  .btn-save.saved:hover {
    background: transparent;
  }

  .btn-save.saving {
    opacity: 0.5;

    cursor: wait;
  }

  /* ---------------------------------------------------------
     Card body
  --------------------------------------------------------- */

  .card-body {
    padding:
      6px 10px 10px 22px;

    font-size: 12px;

    line-height: 1.6;

    white-space: pre-wrap;

    word-wrap: break-word;

    overflow-y: auto;
  }

  .card-body.hidden {
    display: none;
  }

  .card-body b {
    opacity: 0.85;
  }

  /* ---------------------------------------------------------
     Horizontal mode
  --------------------------------------------------------- */

  body.horizontal #list {
    flex-direction: row;

    overflow-x: auto;

    overflow-y: hidden;

    align-items: stretch;
  }

  body.horizontal #list::-webkit-scrollbar {
    height: 4px;
    width: 0;
  }

  body.horizontal .card {
    width: 260px;

    min-width: 260px;

    border-bottom: none;

    border-right:
      1px solid var(--vscode-panel-border);

    display: flex;

    flex-direction: column;
  }

  body.horizontal .card-head {
    flex-shrink: 0;

    border-bottom:
      1px solid var(--vscode-panel-border);
  }

  body.horizontal .card-body {
    flex: 1;

    overflow-y: auto;

    padding: 8px 10px;
  }

  body.horizontal
  .card-body.hidden {
    display: block;
  }

</style>

</head>

<body>

<div id="empty">
  No exercises yet.<br/>
  Click <b>More Exercise</b> to generate one.
</div>

<div id="list"></div>

<script>

  const vscode =
    acquireVsCodeApi();

  const $body =
    document.body;

  const $empty =
    document.getElementById('empty');

  const $list =
    document.getElementById('list');

  // ---------------------------------------------------------
  // Save state
  // ---------------------------------------------------------

  // 'idle' | 'saving' | 'saved'
  const saveState = {};

  // ---------------------------------------------------------
  // Layout
  // ---------------------------------------------------------

  function checkLayout() {
    $body.classList.toggle(
      'horizontal',
      window.innerWidth >
        window.innerHeight * 1.5
    );
  }

  checkLayout();

  window.addEventListener(
    'resize',
    checkLayout
  );

  // ---------------------------------------------------------
  // Webview ready
  // ---------------------------------------------------------

  vscode.postMessage({
    type: 'ready'
  });

  // ---------------------------------------------------------
  // Receive messages from Extension
  // ---------------------------------------------------------

  window.addEventListener(
    'message',
    ({ data }) => {

      if (!data) {
        return;
      }

      if (data.type === 'update') {

        render(
          Array.isArray(data.exercises)
            ? data.exercises
            : []
        );

      } else if (
        data.type === 'savingStart'
      ) {

        setSaveState(
          data.id,
          'saving'
        );

      } else if (
        data.type === 'saveSuccess'
      ) {

        setSaveState(
          data.id,
          'saved'
        );

      } else if (
        data.type === 'saveError'
      ) {

        setSaveState(
          data.id,
          'idle'
        );
      }
    }
  );

  // ---------------------------------------------------------
  // Save button state
  // ---------------------------------------------------------

  function setSaveState(
    id,
    state
  ) {

    saveState[id] = state;

    const btn =
      document.querySelector(
        '.btn-save[data-save="' +
        id +
        '"]'
      );

    if (!btn) {
      return;
    }

    btn.classList.remove(
      'saving',
      'saved'
    );

    if (state === 'saving') {

      btn.classList.add(
        'saving'
      );

      btn.title =
        'Saving...';

      btn.innerHTML =
        '<i class="codicon ' +
        'codicon-loading ' +
        'codicon-modifier-spin">' +
        '</i>';

      btn.disabled = true;

    } else if (
      state === 'saved'
    ) {

      btn.classList.add(
        'saved'
      );

      btn.title =
        'Saved to database';

      btn.innerHTML =
        '<i class="codicon ' +
        'codicon-check">' +
        '</i>';

      btn.disabled = true;

    } else {

      btn.title =
        'Save to database';

      btn.innerHTML =
        '<i class="codicon ' +
        'codicon-save">' +
        '</i>';

      btn.disabled = false;
    }
  }

  // ---------------------------------------------------------
  // Click handling
  // ---------------------------------------------------------

  $list.addEventListener(
    'click',
    (e) => {

      // -----------------------------------------------------
      // Save
      // -----------------------------------------------------

      const btnSave =
        e.target.closest(
          '.btn-save'
        );

      if (
        btnSave &&
        !btnSave.disabled
      ) {

        e.stopPropagation();

        const id =
          parseInt(
            btnSave.dataset.save,
            10
          );

        if (
          saveState[id] !== 'saved' &&
          saveState[id] !== 'saving'
        ) {

          vscode.postMessage({
            type: 'saveExercise',
            id
          });
        }

        return;
      }

      // -----------------------------------------------------
      // Send to Editor
      // -----------------------------------------------------

      const btnArrow =
        e.target.closest(
          '.btn-arrow'
        );

      if (btnArrow) {

        e.stopPropagation();

        const id =
          parseInt(
            btnArrow.dataset.send,
            10
          );

        vscode.postMessage({
          type: 'sendToEditor',
          id
        });

        return;
      }

      // -----------------------------------------------------
      // Toggle collapse
      // -----------------------------------------------------

      const head =
        e.target.closest(
          '.card-head'
        );

      if (head) {

        const key =
          head.dataset.key;

        const body =
          key
            ? document.getElementById(
                'body-' + key
              )
            : null;

        if (body) {

          head.classList.toggle(
            'collapsed'
          );

          body.classList.toggle(
            'hidden'
          );
        }
      }
    }
  );

  // ---------------------------------------------------------
  // HTML escaping
  // ---------------------------------------------------------

  function escapeHtml(str) {

    if (!str) {
      return '';
    }

    return String(str)
      .replace(
        /&/g,
        '&amp;'
      )
      .replace(
        /</g,
        '&lt;'
      )
      .replace(
        />/g,
        '&gt;'
      )
      .replace(
        /"/g,
        '&quot;'
      )
      .replace(
        /'/g,
        '&#39;'
      );
  }

  // ---------------------------------------------------------
  // Render exercises
  // ---------------------------------------------------------

  function render(exercises) {

    if (!exercises.length) {

      $empty.style.display =
        'flex';

      $list.style.display =
        'none';

      $list.innerHTML =
        '';

      return;
    }

    $empty.style.display =
      'none';

    $list.style.display =
      'flex';

    // -------------------------------------------------------
    // Simpan state collapse sebelum re-render
    // -------------------------------------------------------

    const collapsed =
      new Set(
        [
          ...$list.querySelectorAll(
            '.card-head.collapsed'
          )
        ].map(
          h => h.dataset.key
        )
      );

    // -------------------------------------------------------
    // Render
    // -------------------------------------------------------

    $list.innerHTML =
      exercises
        .map(
          (ex) => {

            const key =
              'generated-' +
              ex.id;

            const isCollapsed =
              collapsed.has(key);

            const testCasesText =
              Array.isArray(
                ex.test_cases
              )
                ? ex.test_cases.join(
                    '\\n'
                  )
                : '';

            const state =
              saveState[ex.id] ||
              'idle';

            // -------------------------------------------------
            // Save button
            // -------------------------------------------------

            let saveIcon =
              'codicon-save';

            let saveTitle =
              'Save to database';

            let saveClass =
              '';

            let saveDisabled =
              '';

            if (
              state === 'saving'
            ) {

              saveIcon =
                'codicon-loading ' +
                'codicon-modifier-spin';

              saveTitle =
                'Saving...';

              saveClass =
                'saving';

              saveDisabled =
                'disabled';

            } else if (
              state === 'saved'
            ) {

              saveIcon =
                'codicon-check';

              saveTitle =
                'Saved to database';

              saveClass =
                'saved';

              saveDisabled =
                'disabled';
            }

            const saveButton =
              \`
                <button
                  class="btn-icon btn-save \${saveClass}"
                  data-save="\${ex.id}"
                  title="\${saveTitle}"
                  \${saveDisabled}
                >
                  <i class="codicon \${saveIcon}"></i>
                </button>
              \`;

            // -------------------------------------------------
            // Card
            // -------------------------------------------------

            return \`
              <div class="card">

                <div
                  class="card-head\${isCollapsed ? ' collapsed' : ''}"
                  data-id="\${ex.id}"
                  data-key="\${key}"
                >

                  <span
                    class="chevron codicon codicon-chevron-down"
                  ></span>

                  <span
                    class="card-title"
                  >
                    GENERATED · EXERCISE \${ex.id}
                  </span>

                  \${saveButton}

                  <button
                    class="btn-icon btn-arrow codicon codicon-arrow-up"
                    data-send="\${ex.id}"
                    title="Send to Editor"
                  ></button>

                </div>

                <div
                  class="card-body\${isCollapsed ? ' hidden' : ''}"
                  id="body-\${key}"
                >

                  <b>Topic:</b>
                  \${escapeHtml(ex.topic)}

                  <br/>

                  <b>Problem:</b>
                  \${escapeHtml(
                    ex.problem_statement
                  )}

                  <br/>

                  <b>Example:</b>
                  \${escapeHtml(
                    ex.example
                  )}

                  <br/>

                  <b>Code:</b>
                  \${escapeHtml(
                    ex.function_stub
                  )}

                  <br/>

                  <b>Test Cases:</b>
                  \${escapeHtml(
                    testCasesText
                  )}

                </div>

              </div>
            \`;
          }
        )
        .join('');

    // Scroll ke exercise terbaru
    $list.scrollTop =
      $list.scrollHeight;
  }

</script>

</body>

</html>`;
  }
}