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
import { ExerciseViewProvider } from '../views/ExerciseViewProvider';
import { DatabaseService } from '../services/DatabaseService'; // ← tambah

export async function exerciseGeneratorCommand(
	viewProvider: ExerciseViewProvider,
	db: DatabaseService // ← tambah
): Promise<void> {
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

	// ── Ganti TODO di sini ──────────────────────────────────────
	const diffMap: Record<Difficulty, 'easy' | 'intermediate' | 'hard'> = {
		'Easy': 'easy', 'Medium': 'intermediate', 'Hard': 'hard'
	};
	const shotCountMap: Record<Shot, number> = {
		'0-shot': 0, '1-shot': 1, '2-shot': 2, '3-shot': 3
	};

	const fewShotExamples = await db.getSeedsForShot(
		diffMap[config.difficulty],
		shotCountMap[config.shot]
	);

	console.log('[ExGen] Config:', config);
	console.log('[ExGen] Few-shot examples:', fewShotExamples.map(e => e.title));
	// ────────────────────────────────────────────────────────────

	viewProvider.addExercise();
}