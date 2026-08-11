import * as vscode from 'vscode';
import { DatabaseService, getReferenceSolutions } from '../services/DatabaseService';
import { ExerciseViewProvider } from '../views/ExerciseViewProvider';

// ============================================================
// DIAGNOSTIC COLLECTION
// ============================================================
//
// Digunakan untuk:
// - Problems panel
// - Squiggly underline
//
const diagnosticCollection =
  vscode.languages.createDiagnosticCollection('exgen-feedback');


// ============================================================
// HIGHLIGHT DECORATION
// ============================================================
//
// Digunakan untuk memberikan background highlight pada
// bagian kode yang bermasalah.
//

const highlightDecorationType =
  vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(255, 80, 80, 0.18)',
    border: '1px solid rgba(255, 80, 80, 0.45)',
    borderRadius: '2px',
  });


// Syntax error menggunakan decoration terpisah supaya tidak menggantikan
// AST highlight yang sudah ada.
const syntaxErrorDecorationType =
  vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(255, 80, 80, 0.18)',
    border: '1px solid rgba(255, 80, 80, 0.45)',
    borderRadius: '2px',
  });


// ============================================================
// OUTPUT CHANNEL
// ============================================================
//
// Semua hasil feedback akan ditampilkan di:
//
// VS Code
// → View
// → Output
// → ExGen Feedback
//
// Ini lebih aman daripada menulis langsung ke terminal karena
// OutputChannel memang disediakan oleh VS Code Extension API.
//

const outputChannel =
  vscode.window.createOutputChannel('ExGen Feedback');


// ============================================================
// EXTRACT STUDENT CODE
// ============================================================
//
// Exercise file biasanya memiliki format:
//
// """
// Title        : ...
// Topic        : ...
// Difficulty   : ...
// ...
// """
//
// def function(...):
//     ...
//
// # Test Cases
// assert ...
//
// AST hanya boleh menerima kode Python siswa.
// Karena itu bagian metadata dan test cases harus dibuang.
//

function extractStudentCode(
  fullText: string
): {
  code: string;
  offsetLines: number;
} {

  const lines = fullText.split(/\r\n|\r|\n/);

  // ----------------------------------------------------------
  // Cari penutup metadata """
  // ----------------------------------------------------------

  let docstringEndLine = -1;

  for (let i = 1; i < lines.length; i++) {

    if (lines[i].trim() === '"""') {
      docstringEndLine = i;
      break;
    }
  }

  const codeStartLine =
    docstringEndLine >= 0
      ? docstringEndLine + 1
      : 0;


  // ----------------------------------------------------------
  // Ambil semua baris setelah metadata
  // ----------------------------------------------------------

  const bodyLines =
    lines.slice(codeStartLine);


  // ----------------------------------------------------------
  // Cari # Test Cases
  // ----------------------------------------------------------

  let testCaseLine = -1;

  for (
    let i = bodyLines.length - 1;
    i >= 0;
    i--
  ) {

    if (
      bodyLines[i].trim() === '# Test Cases'
    ) {

      testCaseLine = i;
      break;
    }
  }


  // ----------------------------------------------------------
  // Buang test cases
  // ----------------------------------------------------------

  const codeLines =
    testCaseLine >= 0
      ? bodyLines.slice(0, testCaseLine)
      : bodyLines;


  // ----------------------------------------------------------
  // Buang blank line di awal
  // ----------------------------------------------------------

  let start = 0;

  while (
    start < codeLines.length &&
    codeLines[start].trim() === ''
  ) {

    start++;
  }


  // ----------------------------------------------------------
  // Buang blank line di akhir
  // ----------------------------------------------------------

  let end =
    codeLines.length - 1;

  while (
    end >= start &&
    codeLines[end].trim() === ''
  ) {

    end--;
  }


  const finalCode =
    codeLines
      .slice(start, end + 1)
      .join('\n');


  return {
    code: finalCode,

    // Posisi kode Python relatif terhadap file exercise.
    offsetLines:
      codeStartLine + start,
  };
}


// ============================================================
// DIAGNOSTIC → VS CODE RANGE
// ============================================================
//
// Python AST:
//
// line      = 1-based
// col       = 0-based
// end_line  = 1-based
// end_col   = 0-based
//
// VS Code:
//
// line      = 0-based
// character = 0-based
//

function diagnosticToRange(
  diagnostic: {
    line: number;
    col: number;
    end_line: number;
    end_col: number;
  },
  offsetLines: number
): vscode.Range {

  const startLine =
    Math.max(
      0,
      diagnostic.line - 1 + offsetLines
    );


  const endLine =
    Math.max(
      0,
      diagnostic.end_line - 1 + offsetLines
    );


  const startCol =
    Math.max(
      0,
      diagnostic.col
    );


  // Minimal range harus mempunyai panjang.
  const endCol =
    Math.max(
      startCol + 1,
      diagnostic.end_col
    );


  return new vscode.Range(

    new vscode.Position(
      startLine,
      startCol
    ),

    new vscode.Position(
      endLine,
      endCol
    )
  );
}


// ============================================================
// CLEAR EDITOR FEEDBACK
// ============================================================

function clearSyntaxFeedback(
  editor?: vscode.TextEditor
): void {

  diagnosticCollection.clear();

  if (editor) {
    editor.setDecorations(
      syntaxErrorDecorationType,
      []
    );
  }
}

function clearAstHighlight(
  editor?: vscode.TextEditor
): void {

  if (editor) {
    editor.setDecorations(
      highlightDecorationType,
      []
    );
  }
}

function clearEditorFeedback(
  editor?: vscode.TextEditor
): void {

  diagnosticCollection.clear();

  if (editor) {
    editor.setDecorations(
      highlightDecorationType,
      []
    );
    editor.setDecorations(
      syntaxErrorDecorationType,
      []
    );
  }
}


// ============================================================
// APPLY HIGHLIGHT
// ============================================================

function applyHighlight(
  editor: vscode.TextEditor,
  ranges: vscode.Range[]
): void {

  editor.setDecorations(

    highlightDecorationType,

    ranges.map(range => ({

      range,

      hoverMessage:
        new vscode.MarkdownString(
          '**ExGen Feedback**\n\n' +
          'Bagian kode ini berbeda dari ' +
          'reference solution.'
        ),
    }))
  );
}


// ============================================================
// OUTPUT HEADER
// ============================================================

function printOutputHeader(): void {

  outputChannel.appendLine('');
  outputChannel.appendLine(
    '========================================'
  );

  outputChannel.appendLine(
    '          ExGen Feedback'
  );

  outputChannel.appendLine(
    '========================================'
  );
}


// ============================================================
// OUTPUT FOOTER
// ============================================================

function printOutputFooter(): void {

  outputChannel.appendLine(
    '========================================'
  );

  outputChannel.appendLine('');
}


// ============================================================
// CHECK FEEDBACK COMMAND
// ============================================================

export async function checkFeedbackCommand(
  viewProvider: ExerciseViewProvider,
  db: DatabaseService
): Promise<void> {

  // ----------------------------------------------------------
  // Ambil editor aktif
  // ----------------------------------------------------------

  const editor =
    vscode.window.activeTextEditor;


  if (!editor) {

    vscode.window.showWarningMessage(
      '[ExGen] No active editor. Open an exercise file first.'
    );

    return;
  }


  const doc =
    editor.document;


  // ----------------------------------------------------------
  // Ambil exercise yang sedang dikerjakan
  // ----------------------------------------------------------

  const exercise =
    viewProvider.getExerciseForDocument(doc);


  if (!exercise) {
    vscode.window.showWarningMessage(
      '[ExGen] This file isn\'t linked to an exercise. ' +
      'Use "Send to Editor" from the Exercise panel first.'
    );
    return;
  }

  const referenceSolutions = getReferenceSolutions(exercise);

  if (referenceSolutions.length === 0) {
    vscode.window.showWarningMessage(
      '[ExGen] This exercise has no reference solution.'
    );
    return;
  }


  // ----------------------------------------------------------
  // Bersihkan feedback sebelumnya
  // ----------------------------------------------------------

  clearSyntaxFeedback(editor);


  // ----------------------------------------------------------
  // Ambil seluruh isi file
  // ----------------------------------------------------------

  const fullText =
    doc.getText();


  // ----------------------------------------------------------
  // Ambil kode Python siswa
  // ----------------------------------------------------------

  const {
    code: studentCode,
    offsetLines,
  } =
    extractStudentCode(fullText);


  if (
    !studentCode.trim()
  ) {

    vscode.window.showWarningMessage(
      '[ExGen] No code found to check.'
    );

    return;
  }


  // ----------------------------------------------------------
  // Bersihkan Output Channel
  // ----------------------------------------------------------

  outputChannel.clear();

  outputChannel.show(
    true
  );

  printOutputHeader();


  outputChannel.appendLine(
    'Checking student code...'
  );
  outputChannel.appendLine(
    `Reference solutions: ${referenceSolutions.length}`
  );
  referenceSolutions.forEach((ref, index) => {
    outputChannel.appendLine(`  [${index + 1}] ${ref.technique}`);
  });

  outputChannel.appendLine('');


  // ----------------------------------------------------------
  // Jalankan feedback engine
  // ----------------------------------------------------------

  let result;

  try {

    result =
      await db.checkFeedback(
        studentCode,
        referenceSolutions,
        exercise.test_cases
      );

  } catch (err) {

    const errorMessage =
      err instanceof Error
        ? err.message
        : String(err);


    outputChannel.appendLine(
      `Feedback check failed: ${errorMessage}`
    );

    printOutputFooter();


    vscode.window.showErrorMessage(
      `[ExGen] Feedback check failed: ${errorMessage}`
    );

    return;
  }


  // ==========================================================
  // CASE 1
  // SYNTAX ERROR
  // ==========================================================

  if (!result.compiled) {

    outputChannel.appendLine(
      'Status: SYNTAX ERROR'
    );
    outputChannel.appendLine('');

    if (result.compile_error) {
      outputChannel.appendLine(
        `SyntaxError: ${result.compile_error}`
      );
    }

    type SyntaxDetail = {
      line: number;
      col: number;
      end_line: number;
      end_col: number;
      message?: string;
      detail?: string;
      topic?: string;
      severity?: 'error' | 'warning';
    };

    const syntaxDetails: SyntaxDetail[] =
      Array.isArray(result.compile_error_details)
        ? result.compile_error_details
        : result.compile_error_detail
          ? [result.compile_error_detail]
          : [];

    const syntaxDiagnostics: vscode.Diagnostic[] = [];
    const syntaxRanges: vscode.Range[] = [];

    for (const d of syntaxDetails) {
      const range = diagnosticToRange(
        d,
        offsetLines
      );

      const message: string =
        typeof d.message === 'string' && d.message.length > 0
          ? d.message
          : (
              typeof result.compile_error === 'string'
                ? result.compile_error
                : 'Syntax error'
            );

      const detail: string =
        typeof d.detail === 'string'
          ? d.detail
          : '';

      const diagnosticMessage: string =
        detail.length > 0
          ? `${message}: ${detail}`
          : message;

      const diagnostic = new vscode.Diagnostic(
        range,
        diagnosticMessage,
        vscode.DiagnosticSeverity.Error
      );

      diagnostic.source = 'ExGen Feedback';

      syntaxDiagnostics.push(diagnostic);
      syntaxRanges.push(range);

      outputChannel.appendLine(
        `[Syntax] ${message}`
      );
      outputChannel.appendLine(
        `  Line: ${d.line}`
      );
      outputChannel.appendLine(
        `  Column: ${d.col}`
      );
      outputChannel.appendLine(
        `  End Line: ${d.end_line}`
      );
      outputChannel.appendLine(
        `  End Column: ${d.end_col}`
      );
      if (detail.length > 0) {
        outputChannel.appendLine(
          `  Detail: ${detail}`
        );
      }
      outputChannel.appendLine('');
    }

    diagnosticCollection.set(
      doc.uri,
      syntaxDiagnostics
    );

    editor.setDecorations(
      syntaxErrorDecorationType,
      syntaxRanges.map(range => ({
        range,
        hoverMessage: new vscode.MarkdownString(
          '**ExGen Syntax Error**\n\n' +
          'Perbaiki syntax pada bagian ini.'
        ),
      }))
    );

    outputChannel.appendLine(
      `Syntax Issues: ${syntaxDiagnostics.length}`
    );
    outputChannel.appendLine('');
    outputChannel.appendLine('Score: 0%');
    outputChannel.appendLine(
      'Status: Failed because the code contains a syntax error.'
    );

    printOutputFooter();

    vscode.window.showErrorMessage(
      `[ExGen] ${
        result.compile_error ?? 'Syntax error'
      }`
    );

    return;
  }

  // ==========================================================
  // CASE 2
  // AST DIAGNOSTICS
  // ==========================================================

  // Parsing berhasil. Sekarang hasil AST boleh menggantikan highlight AST
  // dari pengecekan sebelumnya. Jika parsing gagal, highlight AST lama tidak
  // disentuh agar syntax highlight tidak menghapusnya.
  clearAstHighlight(editor);

  const diagnostics:
    vscode.Diagnostic[] = [];


  const highlightRanges:
    vscode.Range[] = [];

  const hasTestCases =
    !!result.test_summary &&
    result.test_summary.total > 0;

  const allTestsPassed =
    hasTestCases &&
    result.test_summary!.passed_count ===
      result.test_summary!.total;


  // ----------------------------------------------------------
  // Print AST result
  // ----------------------------------------------------------

  outputChannel.appendLine(
    'Status: CODE COMPILED'
  );

  outputChannel.appendLine('');


  if (result.diagnostics.length === 0) {

    outputChannel.appendLine(
      allTestsPassed
        ? 'AST Issues: None (all test cases passed)'
        : 'AST Issues: None'
    );

  } else {

    outputChannel.appendLine(
      `AST Issues: ${result.diagnostics.length}`
    );

    outputChannel.appendLine('');


    // --------------------------------------------------------
    // Process each diagnostic
    // --------------------------------------------------------

    for (
      const d of result.diagnostics
    ) {

      const range =
        diagnosticToRange(
          d,
          offsetLines
        );


      // ------------------------------------------------------
      // VS Code Diagnostic
      // ------------------------------------------------------

      const diagnostic =
        new vscode.Diagnostic(

          range,

          `[${d.topic}] ${d.message}: ${d.detail}`,

          d.severity === 'error'
            ? vscode.DiagnosticSeverity.Error
            : vscode.DiagnosticSeverity.Warning
        );


      diagnostic.source =
        'ExGen Feedback';


      diagnostics.push(
        diagnostic
      );


      // ------------------------------------------------------
      // Background highlight
      // ------------------------------------------------------

      highlightRanges.push(
        range
      );


      // ------------------------------------------------------
      // Terminal / Output
      // ------------------------------------------------------

      outputChannel.appendLine(
        `[${d.topic}] ${d.message}`
      );


      outputChannel.appendLine(
        `  Line: ${d.line}`
      );


      outputChannel.appendLine(
        `  Column: ${d.col}`
      );


      outputChannel.appendLine(
        `  End Line: ${d.end_line}`
      );


      outputChannel.appendLine(
        `  End Column: ${d.end_col}`
      );


      if (
        d.detail
      ) {

        outputChannel.appendLine(
          `  Detail: ${d.detail}`
        );
      }


      outputChannel.appendLine('');
    }
  }


  // ----------------------------------------------------------
  // Set Diagnostics
  // ----------------------------------------------------------

  diagnosticCollection.set(
    doc.uri,
    diagnostics
  );


  // ----------------------------------------------------------
  // Set Background Highlight
  // ----------------------------------------------------------

  applyHighlight(
    editor,
    highlightRanges
  );


  // ==========================================================
  // SCORE
  // ==========================================================

  let score = 0;


  if (
    result.test_summary &&
    result.test_summary.total > 0
  ) {

    const summary =
      result.test_summary;


    score =
      Math.round(
        (
          summary.passed_count /
          summary.total
        ) * 100
      );


    // --------------------------------------------------------
    // Score output
    // --------------------------------------------------------

    outputChannel.appendLine(
      '----------------------------------------'
    );


    outputChannel.appendLine(
      `Score: ${score}%`
    );


    outputChannel.appendLine(
      `Test Cases: ${
        summary.passed_count
      }/${summary.total} passed`
    );


    outputChannel.appendLine('');


    // --------------------------------------------------------
    // Detail setiap test case
    // --------------------------------------------------------

    outputChannel.appendLine(
      'Test Case Results:'
    );


    for (
      const test of summary.results
    ) {

      outputChannel.appendLine(

        `  ${
          test.passed
            ? '✓'
            : '✗'
        } ${test.test}`
      );
    }


    outputChannel.appendLine('');
  }

  else {

    // --------------------------------------------------------
    // Fallback jika tidak ada test case
    // --------------------------------------------------------

    score =
      Math.round(
        result.score * 100
      );


    outputChannel.appendLine(
      '----------------------------------------'
    );


    outputChannel.appendLine(
      `Score: ${score}%`
    );


    outputChannel.appendLine(
      'No test cases available.'
    );


    outputChannel.appendLine('');
  }


  // ==========================================================
  // FINAL STATUS
  // ==========================================================

  if (
    result.passed
  ) {

    outputChannel.appendLine(
      'Result: PASSED'
    );

    outputChannel.appendLine(
      'All test cases passed.'
    );


    vscode.window.showInformationMessage(
      `[ExGen] Score: ${score}% — ` +
      'All test cases passed.'
    );

  } else {

    outputChannel.appendLine(
      'Result: NEEDS IMPROVEMENT'
    );


    outputChannel.appendLine(
      `${result.diagnostics.length} issue(s) highlighted.`
    );


    vscode.window.showWarningMessage(
      `[ExGen] Score: ${score}% — ` +
      `${
        result.test_summary
          ? `${result.test_summary.passed_count}/${result.test_summary.total}`
          : 'Some'
      } test cases passed. ` +
      `${result.diagnostics.length} issue(s) highlighted.`
    );
  }


  printOutputFooter();
}


// ============================================================
// CLEAR FEEDBACK DIAGNOSTICS
// ============================================================
//
// Bisa dipanggil ketika:
// - dokumen ditutup
// - user berpindah exercise
// - feedback ingin dibersihkan
//

export function clearFeedbackDiagnostics(
  doc: vscode.TextDocument
): void {

  // Hapus diagnostic.
  diagnosticCollection.delete(
    doc.uri
  );


  // Cari editor yang menggunakan document tersebut.
  const editor =
    vscode.window.visibleTextEditors.find(
      e =>
        e.document.uri.toString() ===
        doc.uri.toString()
    );


  // Hapus semua highlight.
  if (editor) {

    editor.setDecorations(
      highlightDecorationType,
      []
    );

    editor.setDecorations(
      syntaxErrorDecorationType,
      []
    );
  }
}


// ============================================================
// EXPORT
// ============================================================

export {
  diagnosticCollection,
  highlightDecorationType,
  syntaxErrorDecorationType,
  outputChannel
};