/**
 * Reading an AskUserQuestion answer back out of its tool result.
 *
 * The permission response is both the answer and the tool's result, so the result carries
 * `{ questions, answers }` regardless of how the card's state was later recorded — an answer that
 * raced a session restart can still read as canceled. Every reader therefore reads the answers
 * from the result itself and does not gate that read on `state === 'completed'`.
 *
 * Pure and separate from the view so the shapes can be exercised without rendering.
 */

/** The answers map from the tool result, or null when the result is not an answered question. */
export function askUserQuestionAnswers(result: unknown): Record<string, unknown> | null {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
        return null;
    }
    const answers = (result as Record<string, unknown>).answers;
    return answers && typeof answers === 'object' && !Array.isArray(answers)
        ? answers as Record<string, unknown>
        : null;
}

/** One answer arrives as a comma-separated string; an older shape used an array. */
export function answerLabels(answer: unknown): string[] {
    if (Array.isArray(answer)) {
        return answer.filter((label): label is string => typeof label === 'string' && label.length > 0);
    }
    if (typeof answer === 'string') {
        return answer.split(', ').map(label => label.trim()).filter(label => label.length > 0);
    }
    return [];
}
