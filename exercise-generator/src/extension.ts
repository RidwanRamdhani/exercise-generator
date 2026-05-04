import * as vscode from 'vscode';
import { exerciseGeneratorCommand } from './commands/exerciseGenerator';

export function activate(context: vscode.ExtensionContext) {
	const myButton = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		100
	);

	myButton.text = "$(add) More exercise";
	myButton.tooltip = "Klik untuk menambah exercise";
	myButton.command = "exercise-generator.moreExercise";

	const cmd = vscode.commands.registerCommand(
		'exercise-generator.moreExercise',
		exerciseGeneratorCommand
	);

	myButton.show();

	context.subscriptions.push(myButton, cmd);
}

export function deactivate() {}