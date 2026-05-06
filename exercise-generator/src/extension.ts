import * as vscode from 'vscode';
import { exerciseGeneratorCommand } from './commands/exerciseGenerator';
import { ExerciseViewProvider } from './views/ExerciseViewProvider';

export function activate(context: vscode.ExtensionContext) {

	const viewProvider = new ExerciseViewProvider(context.extensionUri);

	const view = vscode.window.registerWebviewViewProvider(
		'exerciseView',
		viewProvider
	);

	const myButton = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		100
	);
	myButton.text = "$(add) More exercise";
	myButton.tooltip = "Klik untuk menambah exercise";
	myButton.command = "exercise-generator.moreExercise";
	myButton.show();

	const cmd = vscode.commands.registerCommand(
		'exercise-generator.moreExercise',
		() => exerciseGeneratorCommand(viewProvider)
	);

	context.subscriptions.push(myButton, cmd, view);
}

export function deactivate() {}