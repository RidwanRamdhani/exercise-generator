import * as vscode from 'vscode';
import * as path from 'path';
import { DatabaseService } from '../services/DatabaseService';

export async function exportToMoodleXmlCommand(
  db: DatabaseService,
  extensionPath: string
): Promise<void> {
  const source = await vscode.window.showQuickPick(
    [
      {
        label: '$(database) Semua exercise dari database',
        description: 'Export seeds + generated exercises yang tersimpan di extension',
        value: 'database'
      },
      {
        label: '$(file) Pilih file JSON custom',
        description: 'Pilih file JSON exercise manual',
        value: 'file'
      }
    ],
    { placeHolder: 'Pilih sumber exercise untuk export' }
  );

  if (!source) { return; }

  let outputPath: string;

  if (source.value === 'file') {
    const inputUri = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      defaultUri: vscode.Uri.file(extensionPath),
      filters: {
        'JSON files': ['json'],
        'All files': ['*']
      },
      title: 'Pilih file JSON exercise yang akan diexport'
    });

    if (!inputUri || inputUri.length === 0) {
      vscode.window.showInformationMessage('[ExGen] Export dibatalkan.');
      return;
    }

    const defaultOutputPath = path.join(
      path.dirname(inputUri[0].fsPath),
      path.basename(inputUri[0].fsPath, '.json') + '_moodle.xml'
    );

    const outputUri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(defaultOutputPath),
      filters: {
        'XML files': ['xml'],
        'All files': ['*']
      },
      title: 'Simpan Moodle XML sebagai...'
    });

    if (!outputUri) {
      vscode.window.showInformationMessage('[ExGen] Export dibatalkan.');
      return;
    }

    outputPath = outputUri.fsPath;

    const statusBar = vscode.window.setStatusBarMessage(
      '$(sync~spin) ExGen: Exporting to Moodle XML...'
    );

    try {
      const result = await db.exportMoodleXml(inputUri[0].fsPath, outputPath);
      if (result.ok) {
        vscode.window.showInformationMessage(
          `[ExGen] Berhasil export ${result.count ?? 0} soal ke:\n${outputPath}`
        );
      } else {
        vscode.window.showErrorMessage('[ExGen] Export gagal. Cek log untuk detail.');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`[ExGen] Export error: ${message}`);
    } finally {
      statusBar.dispose();
    }
    return;
  }

  const scope = await vscode.window.showQuickPick(
    [
      {
        label: '$(circle-slash) Belum pernah diekspor',
        description: 'Hanya exercise yang belum pernah dimasukkan ke LMS',
        value: 'unexported'
      },
      {
        label: '$(database) Semua exercise',
        description: 'Export semua exercise dari database (seeds + generated)',
        value: 'all'
      }
    ],
    { placeHolder: 'Pilih exercise yang akan diexport' }
  );

  if (!scope) { return; }

  const onlyUnexported = scope.value === 'unexported';

  const defaultOutputPath = path.join(extensionPath, 'moodle_export.xml');

  const outputUri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(defaultOutputPath),
    filters: {
      'XML files': ['xml'],
      'All files': ['*']
    },
    title: 'Simpan Moodle XML sebagai...'
  });

  if (!outputUri) {
    vscode.window.showInformationMessage('[ExGen] Export dibatalkan.');
    return;
  }

  outputPath = outputUri.fsPath;

  const scopeLabel = onlyUnexported ? 'belum pernah diekspor' : 'semua';
  const statusBar = vscode.window.setStatusBarMessage(
    `$(sync~spin) ExGen: Exporting ${scopeLabel} from database...`
  );

  try {
    const result = await db.exportMoodleXmlFromDb(outputPath, {
      onlyUnexported,
      markExported: true
    });

    if (result.ok) {
      const action = onlyUnexported ? 'yang belum pernah diekspor' : 'semua';
      vscode.window.showInformationMessage(
        `[ExGen] Berhasil export ${result.count ?? 0} soal ${action} dari database ke:\n${outputPath}`
      );
    } else {
      vscode.window.showErrorMessage('[ExGen] Export gagal. Cek log untuk detail.');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`[ExGen] Export error: ${message}`);
  } finally {
    statusBar.dispose();
  }
}