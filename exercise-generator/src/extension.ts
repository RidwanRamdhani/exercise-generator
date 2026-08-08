import * as vscode from 'vscode';
import { exerciseGeneratorCommand } from './commands/exerciseGenerator';
import { ExerciseViewProvider } from './views/ExerciseViewProvider';
import { exportToMoodleXmlCommand } from './commands/moodleXmlExporter';
import { DatabaseViewProvider } from './views/DatabaseViewProvider';
import { DatabaseService } from './services/DatabaseService';

export async function activate(context: vscode.ExtensionContext) {
  const db = new DatabaseService(context.extensionPath);
  await db.importSeeds();
  await db.importJudges();

  const viewProvider    = new ExerciseViewProvider(context.extensionUri, db);
  const dbViewProvider  = new DatabaseViewProvider(context.extensionUri, db);

  const view = vscode.window.registerWebviewViewProvider(
    'exerciseView',
    viewProvider
  );

  const dbView = vscode.window.registerWebviewViewProvider(
    'databaseView',
    dbViewProvider
  );


  const moreExercise = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  moreExercise.text    = '$(add) More exercise';
  moreExercise.tooltip = 'Klik untuk menambah exercise';
  moreExercise.command = 'exercise-generator.moreExercise';
  moreExercise.show();


  const showDatabase = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    99
  );
  showDatabase.text    = 'Show Database';
  showDatabase.tooltip = 'Exercise yang tersimpan di database';
  showDatabase.command = 'exercise-generator.showDatabase';
  showDatabase.show();

  const exportMoodle = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    98
  );
  exportMoodle.text    = '$(export) Export Moodle';
  exportMoodle.tooltip = 'Export exercise ke Moodle XML (CodeRunner)';
  exportMoodle.command = 'exercise-generator.exportToMoodleXml';
  exportMoodle.show();

  const moreExerciseCmd = vscode.commands.registerCommand(
    'exercise-generator.moreExercise',
    () => exerciseGeneratorCommand(viewProvider, db, context.extensionPath)
  );

  const showDatabaseCmd = vscode.commands.registerCommand(
    'exercise-generator.showDatabase',
    () => vscode.commands.executeCommand('databaseView.focus')
  );
  const exportMoodleCmd = vscode.commands.registerCommand(          
    'exercise-generator.exportToMoodleXml',
    () => exportToMoodleXmlCommand(db, context.extensionPath)
  );

  context.subscriptions.push(
    moreExercise,
    showDatabase,
    exportMoodle,
    moreExerciseCmd,
    showDatabaseCmd,
    exportMoodleCmd,
    view,
    dbView
  );
}

export function deactivate() {}