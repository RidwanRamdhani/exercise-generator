import * as vscode from 'vscode';
import * as path from 'path';
import { DatabaseService } from '../services/DatabaseService';

export async function exportToMoodleXmlCommand(
  db: DatabaseService,
  extensionPath: string
): Promise<void> {
  // 1. Minta user pilih file JSON sumber
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
    vscode.window.showInformationMessage('[ExGen] Export dibatalkan: tidak ada file yang dipilih.');
    return;
  }

  const inputPath = inputUri[0].fsPath;

  // 2. Minta user tentukan path output XML
  const defaultOutputPath = path.join(
    path.dirname(inputPath),
    path.basename(inputPath, '.json') + '_moodle.xml'
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
    vscode.window.showInformationMessage('[ExGen] Export dibatalkan: tidak ada lokasi penyimpanan.');
    return;
  }

  const outputPath = outputUri.fsPath;

  // 3. Jalankan konversi
  const statusBar = vscode.window.setStatusBarMessage(
    '$(sync~spin) ExGen: Exporting to Moodle XML...'
  );

  try {
    const result = await db.exportMoodleXml(inputPath, outputPath);

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
}