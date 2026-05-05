import * as vscode from 'vscode';
import { ExerciseConfig, Difficulty, Shot } from '../types/exercise';
import {
	askForTopic,
	askForDifficulty,
	askForShot,
	askForFilters,
	showCancelledMessage,
	showExerciseSummary
} from '../dialogs';
import { ExerciseViewProvider } from '../views/ExerciseViewProvider'; // ← tambah ini

export async function exerciseGeneratorCommand(viewProvider: ExerciseViewProvider): Promise<void> { // ← tambah parameter
	const topicInput = await askForTopic();
	if (topicInput === undefined) {
		showCancelledMessage('input topic');
		return;
	}

	const difficultyInput = await askForDifficulty();
	if (!difficultyInput) {
		showCancelledMessage('choosing difficulty');
		return;
	}

	const shotInput = await askForShot();
	if (!shotInput) {
		showCancelledMessage('choosing shot amount');
		return;
	}

	const inputFilter = await askForFilters();
	if (!inputFilter || inputFilter.length === 0) {
		showCancelledMessage('filter selection');
		return;
	}

	const config: ExerciseConfig = {
		topic: topicInput,
		difficulty: difficultyInput.label as Difficulty,
		shot: shotInput.label as Shot,
		filters: inputFilter.map(f => f.label)
	};

	showExerciseSummary({
		topic: config.topic,
		difficultyLabel: config.difficulty,
		shotLabel: config.shot,
		filterLabels: config.filters.join(', ')
	});

	// TODO: Implement actual exercise generation using config
	console.log('Exercise configuration:', config);

	viewProvider.addExercise(); // ← tambah ini (dummy, nanti diganti hasil LLM)
}