import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { ExerciseConfig, Difficulty, Shot } from '../types/exercise';
import {
	askForTopic,
	askForDifficulty,
	askForShot,
	askForFilters,
	showCancelledMessage,
	showExerciseSummary
} from '../dialogs';
import { ExerciseViewProvider, GeneratedExercise } from '../views/ExerciseViewProvider';
import { DatabaseService, FilterResult } from '../services/DatabaseService';

export async function exerciseGeneratorCommand(
  viewProvider: ExerciseViewProvider,
  db: DatabaseService,
  extensionPath: string
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

  // Tentukan filter yang aktif dari pilihan user
  const applyTestcaseCheck = config.filters.includes('Testcase Check');
  const applyDifficultyCheck = config.filters.includes('Difficulty Check');

  // ── Status bar loading indicator ─────────────────────────────────────────
  // Muncul setelah semua dialog input selesai, hilang otomatis setelah
  // proses LLM + filter selesai (baik sukses maupun error).
  const statusBar = vscode.window.setStatusBarMessage('$(sync~spin) ExGen: Generating exercises...');

  try {
    const results = await callLLM(config, fewShotExamples, extensionPath);

    let passed  = 0;
    let skipped = 0;

    for (const result of results) {
      // ── Filter Chain (sesuai paper Fig. 6) ───────────────────────────────
      // Filter hanya dijalankan jika user memilih "Testcase Check".
      // Chain: Compilation Check → Unit Testing Check
      // Jika salah satu gagal, exercise dibuang dan tidak ditampilkan.
      // ── Difficulty Check (LLM Self-Reflection) ────────────────────────────
      // Jika "Difficulty Check" dipilih, LLM memverifikasi apakah exercise sesuai level.

      let filterResult: FilterResult | null = null;

      if (applyTestcaseCheck) {
        vscode.window.setStatusBarMessage(`$(sync~spin) ExGen: Checking "${result.title}"...`);

        filterResult = await db.runFilters({
          solution:   result.solution ?? '',
          test_cases: result.test_cases ?? []
        });

        if (!filterResult.passed) {
          skipped++;

          // Log detail kegagalan untuk debugging
          if (!filterResult.compilation.passed) {
            console.warn(
              `[ExGen] Exercise "${result.title}" FAILED compilation:`,
              filterResult.compilation.error
            );
          } else if (filterResult.unit_test && !filterResult.unit_test.passed) {
            console.warn(
              `[ExGen] Exercise "${result.title}" FAILED unit test:`,
              filterResult.unit_test.error
            );
          }

          // Buang exercise ini — tidak push ke viewProvider
          continue;
        }

        console.log(`[ExGen] Exercise "${result.title}" PASSED test filters.`);
      }

      if (applyDifficultyCheck) {
        vscode.window.setStatusBarMessage(`$(sync~spin) ExGen: Verifying difficulty "${result.title}"...`);

        const difficultyCheck = await db.checkDifficulty(
          { ...result, topic: config.topic, difficulty: config.difficulty, shot: config.shot, filters_applied: config.filters, solution: result.solution ?? '' },
          config.difficulty
        );

        console.log(`[ExGen] Difficulty check result for "${result.title}"`, difficultyCheck);

        if (!difficultyCheck.passed) {
          skipped++;
          console.warn(
            `[ExGen] Exercise "${result.title}" FAILED difficulty check:`,
            difficultyCheck.error,
            `Problem stmt: ${result.problem_statement.substring(0, 100)}...`
          );
          continue;
        }

        console.log(`[ExGen] Exercise "${result.title}" PASSED difficulty check.`);
      }

      // ── Exercise lolos filter (atau filter tidak diaktifkan) ──────────────
      const exercise: Omit<GeneratedExercise, 'id'> = {
        title:             result.title,
        topic:             config.topic,
        difficulty:        config.difficulty,
        problem_statement: result.problem_statement,
        example:           result.example,
        function_stub:     result.function_stub,
        test_cases:        result.test_cases,
        shot:              config.shot,
        filters_applied:   config.filters
      };

      viewProvider.addGeneratedExercise(exercise);
      passed++;
    }

    // Beri tahu user ringkasan hasil filter
    const difficultyMsg = applyDifficultyCheck ? ' difficulty check,' : '';
    if ((applyTestcaseCheck || applyDifficultyCheck) && skipped > 0) {
      vscode.window.showInformationMessage(
        `[ExGen] ${passed} exercise(s) passed filters. ` +
        `${skipped} exercise(s) were discarded (failed compilation, unit test${difficultyMsg} or difficulty mismatch).`
      );
    }

    if (passed === 0) {
      vscode.window.showWarningMessage(
        '[ExGen] No ready-to-use exercises were generated. ' +
        'Try again or adjust the keyword/difficulty.'
      );
    }

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Failed to generate exercise: ${message}`);
  } finally {
    // Selalu hilangkan status bar message setelah selesai
    statusBar.dispose();
  }
}

type LLMExercise = {
  title: string;
  problem_statement: string;
  example: string;
  function_stub: string;
  test_cases: string[];
  solution?: string;
};

type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

type OpenRouterResponse = {
  choices?: Array<{ message?: { content?: string } }>;
};

/**
 * Build the prompt messages
 *
 * SYSTEM MESSAGE
 * - Defines the assistant role and explains all difficulty levels.
 *
 * ZERO-SHOT (0 examples)
 * - Uses only the system message and a single user request for N exercises.
 *
 * FEW-SHOT (1–3 examples)
 * - Injects examples as alternating user/assistant turns:
 *   user:      "Give me a {difficulty} Python exercise."
 *   assistant: "Here is one {difficulty} Python exercise: {example}"
 * - Ends with a final user request for N new exercises using the keyword.
 */
function buildMessages(
  config: ExerciseConfig,
  fewShotExamples: any[],
  difficultyLabel: string
): ChatMessage[] {
  // Message 1: system message.
  // Defines the role and difficulty tiers to establish shared context.
  const systemMessage: ChatMessage = {
    role: 'system',
    content:
      'You are a helpful teaching assistant for undergraduates who are learning ' +
      'introductory programming in Python. You need to generate Python exercises ' +
      'for students to practice.\n\n' +
      'There are three levels of difficulty for the exercises:\n' +
      'Easy: most students will solve the problem quickly with a few lines of code.\n' +
      'Intermediate: most students will take more time to solve the problem, and ' +
      'they need to write more code. Many students, but not all, will be able to ' +
      'solve the problem in the end.\n' +
      'Hard: most students will take a lot of time to solve the problem. Many of ' +
      'them will not be able to solve the problem in the end.\n\n' +
      'For each exercise you generate, respond ONLY with valid JSON containing ' +
      'these fields: title, problem_statement, example, function_stub, ' +
      'test_cases, solution.\n' +
      'The function_stub must include a Python function definition ending with pass.\n' +
      'test_cases must be an array of assert strings.\n' +
      'solution must be the complete correct Python implementation.'
  };

  const messages: ChatMessage[] = [systemMessage];

  // Few-shot turns: alternating user/assistant messages.
  //   user:      "Give me a {difficulty} Python exercise."
  //   assistant: "Here is one {difficulty} Python exercise: {exercise JSON}"
  // Each example is one user+assistant pair to reinforce format and difficulty.
  for (const ex of fewShotExamples) {
    messages.push({
      role: 'user',
      content: `Give me a ${difficultyLabel} Python exercise.`
    });

    const exampleJson = JSON.stringify({
      title: ex.title,
      problem_statement: ex.problem_statement,
      example: ex.example ?? '',
      function_stub: ex.function_stub ?? `def solution():\n    pass`,
      test_cases: ex.test_cases ?? [],
      solution: ex.solution ?? ''
    }, null, 2);

    messages.push({
      role: 'assistant',
      content: `Here is one ${difficultyLabel} Python exercise:\n${exampleJson}`
    });
  }

  // Final message: user request with the keyword.
  const isZeroShot = fewShotExamples.length === 0;

  const finalUserContent = isZeroShot
    ? `Give me 3 ${difficultyLabel} Python exercises using this keyword: ` +
      `${config.topic}. ` +
      `Return a JSON array where each element has fields: title, ` +
      `problem_statement, example, function_stub, test_cases, solution. ` +
      `Return JSON only.`
    : `Good. I want 3 more ${difficultyLabel} Python exercises using this ` +
      `keyword: ${config.topic}. ` +
      `Print the result with the same format as the previous ones. ` +
      `Return a JSON array only.`;

  messages.push({
    role: 'user',
    content: finalUserContent
  });

  return messages;
}

async function callLLM(
  config: ExerciseConfig,
  fewShotExamples: any[],
  extensionPath: string
): Promise<LLMExercise[]> {
  loadEnvFromFile(extensionPath);

  const useOllama = process.env.USE_OLLAMA === 'true';
  const apiKey = useOllama ? 'ollama' : process.env.OPENROUTER_API_KEY;

  if (!useOllama && !apiKey) {
    throw new Error('Missing OPENROUTER_API_KEY in environment. Set USE_OLLAMA=true for local Ollama.');
  }

  const model = process.env.OPENROUTER_MODEL || (useOllama ? 'llama3.2' : 'nvidia/nemotron-3-super-120b-a12b:free');

  const diffMap: Record<Difficulty, string> = {
    'Easy': 'easy',
    'Medium': 'intermediate',
    'Hard': 'hard'
  };
  const difficultyLabel = diffMap[config.difficulty];

  const messages = buildMessages(config, fewShotExamples, difficultyLabel);

  console.log('[ExGen] Prompting strategy:', fewShotExamples.length === 0 ? 'zero-shot' : `${fewShotExamples.length}-shot`);
  console.log('[ExGen] Total messages in prompt:', messages.length);
  console.log('[ExGen] Using:', useOllama ? 'Ollama (localhost)' : 'OpenRouter');

  const payload = JSON.stringify({
    model,
    temperature: 0.7,
    max_tokens: 4095,
    messages
  });

  const baseUrl = useOllama
    ? 'http://localhost:11434/v1/chat/completions'
    : 'https://openrouter.ai/api/v1/chat/completions';

  const responseText = await httpRequest(
    baseUrl,
    payload,
    {
      Authorization: useOllama ? '' : `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload).toString(),
      'HTTP-Referer': 'vscode-extension',
      'X-Title': 'exercise-generator'
    },
    useOllama
  );

  let responseJson: OpenRouterResponse;
  try {
    responseJson = JSON.parse(responseText) as OpenRouterResponse;
  } catch {
    throw new Error('LLM response is not valid JSON');
  }

  const content = responseJson.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('LLM response missing content');
  }

  const parsed = parseJsonFromContent(content);
  const exercises = Array.isArray(parsed) ? parsed : [parsed];
  for (const exercise of exercises) {
    validateLLMExercise(exercise);
  }
  return exercises;
}

function loadEnvFromFile(extensionPath: string): void {
  if (process.env.OPENROUTER_API_KEY || process.env.USE_OLLAMA === 'true') {
    return;
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const candidateRoots = [extensionPath, workspaceRoot].filter(
    (root): root is string => Boolean(root)
  );

  const envPath = candidateRoots
    .map(root => path.join(root, '.env'))
    .find(candidate => fs.existsSync(candidate));

  if (!envPath) { return; }

  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) { continue; }
    const idx = trimmed.indexOf('=');
    if (idx === -1) { continue; }
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function httpRequest(
  url: string,
  body: string,
  headers: Record<string, string>,
  useHttp: boolean = false
): Promise<string> {
  return new Promise((resolve, reject) => {
    const requestFn = useHttp ? http.request : https.request;
    const request = requestFn(url, { method: 'POST', headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    request.on('error', (err) => reject(err));
    request.write(body);
    request.end();
  });
}

function parseJsonFromContent(content: string): LLMExercise | LLMExercise[] {
  const trimmed = content.trim();

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = fenced ? fenced[1].trim() : trimmed;

  if (jsonStr.startsWith('[')) {
    return JSON.parse(jsonStr) as LLMExercise[];
  }

  if (jsonStr.startsWith('{')) {
    return JSON.parse(jsonStr) as LLMExercise;
  }

  const match = jsonStr.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  if (!match) {
    throw new Error('LLM content does not contain JSON');
  }
  return JSON.parse(match[0]) as LLMExercise | LLMExercise[];
}

function validateLLMExercise(data: LLMExercise): void {
  if (!data || typeof data !== 'object') {
    throw new Error('LLM response is empty');
  }
  const requiredStrings = ['title', 'problem_statement', 'example', 'function_stub'] as const;
  for (const key of requiredStrings) {
    if (!data[key] || typeof data[key] !== 'string') {
      throw new Error(`LLM response missing ${key}`);
    }
  }
  if (!Array.isArray(data.test_cases) || data.test_cases.length === 0) {
    throw new Error('LLM response missing test_cases');
  }
}