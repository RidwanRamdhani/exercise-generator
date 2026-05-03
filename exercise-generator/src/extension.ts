import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    const myButton = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right, 
        100
    );

    myButton.text = "$(add) More exercise";
    myButton.tooltip = "Klik untuk menambah exercise";
    myButton.command = "exercise-generator.moreExercise";

    const cmd = vscode.commands.registerCommand('exercise-generator.moreExercise', async () => {
         const topicInput = await vscode.window.showInputBox({
            placeHolder: "String, List, Nested List, etc",
            prompt: "Enter the topic for the exercise",          
            value: ""             
        });

        if (topicInput === undefined) {
            vscode.window.showWarningMessage("Canceled at input topic");
            return;
        }

		const difficultyInput = await vscode.window.showQuickPick([
			{ label: 'Easy', description: 'Uses basic concepts with straightforward logic' },
			{ label: 'Medium', description: 'Combines multiple concepts with more complex reasoning' },
			{ label: 'Hard', description: 'Requires deeper understanding and advanced problem-solving skills' }
		], {
			placeHolder: 'Choose difficulty'
		});

		if (!difficultyInput) {
            vscode.window.showWarningMessage("Canceled at choosing difficulty");
            return;
        }

		const shotInput = await vscode.window.showQuickPick([
			{ label: '0-shot', description: 'No examples provided in the prompt' },
			{ label: '1-shot', description: 'One example to guide the model' },
			{ label: '2-shot', description: 'Two examples for better context' },
			{ label: '3-shot', description: 'Three examples for maximum guidance' }
		], {
			placeHolder: 'Choose Amount of Shot'
		});

		if (!shotInput) {
			vscode.window.showWarningMessage("Canceled at choosing shot amount");
			return;
		}

		const inputFilter = await vscode.window.showQuickPick([
			{ label: 'Testcase Check'},
			{ label: 'Difficulty Check' }
		], {
			canPickMany: true,
			placeHolder: 'Choose exercise filter'
		});

		if (!inputFilter || inputFilter.length === 0) {
			vscode.window.showWarningMessage("No filter selected");
			return;
		}

		const filterLabels = inputFilter.map(f => f.label).join(', ');

		vscode.window.showInformationMessage(`Exercise Topic: ${topicInput} | Exercise difficulty: ${difficultyInput.label} | Amount of shot: ${shotInput.label} | Filter Selected: ${filterLabels}`);
    });

    myButton.show();

    context.subscriptions.push(myButton, cmd);
}

export function deactivate() {}