import { VerificationError, } from './openai.js';
function addUsage(a, b) {
    if (!b)
        return a;
    return {
        promptTokens: a.promptTokens + b.promptTokens,
        completionTokens: a.completionTokens + b.completionTokens,
        totalTokens: a.totalTokens + b.totalTokens,
    };
}
/**
 * レビューを生成し、verified モードでは検証・修正した最終結果を確定する。
 * ここでは GitHub への投稿を行わない（呼び出し側が確定結果のみを投稿する）。
 */
export async function runReview(config, openai, prompt) {
    const draft = await openai.generateReview(prompt);
    if (config.reviewMode !== 'verified') {
        return { status: 'single', review: draft };
    }
    const failed = (reason, extra) => {
        console.warn(`⚠️  検証未完了: ${reason}`);
        return {
            status: 'verification_failed',
            reason,
            review: {
                summary: '',
                lineComments: [],
                model: draft.model,
                tokenUsage: addUsage(draft.tokenUsage, extra),
            },
        };
    };
    // 候補全体が2回目の入力に収まらない場合は、候補を落とさず検証未完了とする。
    if (config.maxInputTokens !== undefined &&
        openai.estimateVerificationTokens(prompt, draft) > config.maxInputTokens) {
        return failed('下書きと候補が検証の入力上限に収まりませんでした');
    }
    try {
        const verified = await openai.verifyReview(prompt, draft);
        return {
            status: 'verified',
            review: {
                ...verified,
                tokenUsage: addUsage(draft.tokenUsage, verified.tokenUsage),
            },
        };
    }
    catch (error) {
        if (error instanceof VerificationError) {
            return failed(error.message, error.tokenUsage);
        }
        throw error;
    }
}
