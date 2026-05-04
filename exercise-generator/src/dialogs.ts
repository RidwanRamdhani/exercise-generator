import * as vscode from 'vscode';
import {
	DIFFICULTY_OPTIONS,
	SHOT_OPTIONS,
	FILTER_OPTIONS,
	Difficulty,
	Shot
} from './types/exercise';

export async function askForTopic(): Promise<string | undefined> {
	return vscode.window.showInputBox({
		placeHolder: 'String, List, Nested List, etc',
		prompt: 'Enter the topic for the exercise',
		value: ''
	});
}

export async function askForDifficulty(): Promise<{ label: Difficulty } | undefined> {
	return vscode.window.showQuickPick(DIFFICULTY_OPTIONS, {
		placeHolder: 'Choose difficulty'
	});
}

export async function askForShot(): Promise<{ label: Shot } | undefined> {
	return vscode.window.showQuickPick(SHOT_OPTIONS, {
		placeHolder: 'Choose Amount of Shot'
	});
}

export async function askForFilters(): Promise<{ label: string }[] | undefined> {
	return vscode.window.showQuickPick(FILTER_OPTIONS, {
		canPickMany: true,
		placeHolder: 'Choose exercise filter'
	});
}

export function showCancelledMessage(stage: string): void {
	vscode.window.showWarningMessage(`Canceled at ${stage}`);
}

export function showExerciseSummary(config: { topic: string; difficultyLabel: string; shotLabel: string; filterLabels: string }): void {
	vscode.window.showInformationMessage(
		`Exercise Topic: ${config.topic} | Exercise difficulty: ${config.difficultyLabel} | Amount of shot: ${config.shotLabel} | Filter Selected: ${config.filterLabels}`
	);
}
