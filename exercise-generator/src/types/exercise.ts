export type Difficulty = 'Easy' | 'Medium' | 'Hard';

export type Shot = '0-shot' | '1-shot' | '2-shot' | '3-shot';

export interface FilterOption {
	label: string;
	description?: string;
}

export interface ExerciseConfig {
	topic: string;
	difficulty: Difficulty;
	shot: Shot;
	filters: string[];
}

export const DIFFICULTY_OPTIONS: readonly { label: Difficulty; description: string }[] = [
	{ label: 'Easy', description: 'Uses basic concepts with straightforward logic' },
	{ label: 'Medium', description: 'Combines multiple concepts with more complex reasoning' },
	{ label: 'Hard', description: 'Requires deeper understanding and advanced problem-solving skills' }
];

export const SHOT_OPTIONS: readonly { label: Shot; description: string }[] = [
	{ label: '0-shot', description: 'No examples provided in the prompt' },
	{ label: '1-shot', description: 'One example to guide the model' },
	{ label: '2-shot', description: 'Two examples for better context' },
	{ label: '3-shot', description: 'Three examples for maximum guidance' }
];

export const FILTER_OPTIONS: readonly FilterOption[] = [
	{ label: 'Testcase Check' },
	{ label: 'Difficulty Check' }
];
