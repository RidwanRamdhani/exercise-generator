import * as assert from 'assert';

import * as vscode from 'vscode';
import {
	DIFFICULTY_OPTIONS,
	SHOT_OPTIONS,
	FILTER_OPTIONS,
	Difficulty,
	Shot
} from '../types/exercise';
import { exerciseGeneratorCommand } from '../commands/exerciseGenerator';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('Difficulty options should contain Easy, Medium, Hard', () => {
		const labels = DIFFICULTY_OPTIONS.map(o => o.label);
		assert.strictEqual(labels.includes('Easy' as Difficulty), true);
		assert.strictEqual(labels.includes('Medium' as Difficulty), true);
		assert.strictEqual(labels.includes('Hard' as Difficulty), true);
	});

	test('Shot options should contain 0-shot through 3-shot', () => {
		const labels = SHOT_OPTIONS.map(o => o.label);
		assert.strictEqual(labels.includes('0-shot' as Shot), true);
		assert.strictEqual(labels.includes('1-shot' as Shot), true);
		assert.strictEqual(labels.includes('2-shot' as Shot), true);
		assert.strictEqual(labels.includes('3-shot' as Shot), true);
	});

	test('Filter options should contain Testcase Check and Difficulty Check', () => {
		const labels = FILTER_OPTIONS.map(o => o.label);
		assert.strictEqual(labels.includes('Testcase Check'), true);
		assert.strictEqual(labels.includes('Difficulty Check'), true);
	});

	test('exerciseGeneratorCommand is a function', () => {
		assert.strictEqual(typeof exerciseGeneratorCommand, 'function');
	});
});
