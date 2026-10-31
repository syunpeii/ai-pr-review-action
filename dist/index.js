// path: scripts/review/src/index.ts
import { loadConfig } from './config.js';
import { GitHubService } from './github.js';
import { OpenAIService } from './openai.js';
import { ContextBuilder } from './context.js';
import { runReview } from './review-runner.js';
function formatCommentBody(content) {
    if (!content)
        return '';
    return content
        // **見出し** の後に改行を確保
        .replace(/(\*\*[^*]+\*\*)\s*/g, '$1\n\n')
        // - リスト項目の前に改行を確保（ただし既に改行がある場合は除く）
        .replace(/([^\n])\s*-\s+/g, '$1\n\n- ')
        // 行頭の - の前の余分な改行を調整
        .replace(/\n{3,}-/g, '\n\n-')
        // 連続する改行を制限
        .replace(/\n{3,}/g, '\n\n')
        // 先頭末尾の余分な改行を削除
        .trim();
}
async function main() {
    try {
        console.log('🚀 AI PR Review を開始します...');
        const config = loadConfig();
        console.log(`📋 PR #${config.pullNumber} をレビューします`);
        const github = new GitHubService(config);
        const openai = new OpenAIService(config);
        const contextBuilder = new ContextBuilder(config.filePriorities, config.includePrTitle, config.includePrBody, config.includePrLabels);
        console.log('📥 PR情報を取得中...');
        const prInfo = await github.getPRInfo();
        console.log(`📁 ${prInfo.files.length} ファイルの変更を検出`);
        console.log('🤖 AIレビューを生成中...');
        // verified では検証候補の入力領域を残すため、1回目のコード入力を少し絞る。
        const promptBudget = config.reviewMode === 'verified' && config.maxInputTokens !== undefined
            ? Math.max(1, Math.floor(config.maxInputTokens * 0.8))
            : config.maxInputTokens;
        const { prompt, wasTruncated } = contextBuilder.buildPrompt(prInfo, promptBudget);
        const outcome = await runReview(config, openai, prompt);
        const review = outcome.review;
        // 確定した結果のみを投稿する（下書き・検証の内部理由は投稿しない）
        if (outcome.status === 'verification_failed') {
            review.summary =
                '⚠️ **検証未完了**: 検証付きレビューの2回目が完了しなかったため、未検証の指摘は投稿していません。このPRに問題がないという意味ではありません。' +
                    '\n\n**レビュー方式**: 検証付きレビュー（1回目のみ実行、検証未完了）';
        }
        else if (outcome.status === 'verified') {
            review.summary += '\n\n**レビュー方式**: 検証付きレビュー（2段階完了）';
        }
        // トークン制限による切り詰めがあった場合の警告追加
        if (wasTruncated) {
            review.summary += '\n\n⚠️ **注意**: このPRは大きすぎるため、一部のファイル詳細を省略してレビューを行いました。重要な変更が見落とされている可能性があります。';
        }
        console.log('📝 レビューコメントを投稿中...');
        // 概要コメントを通常のIssueコメントとして投稿
        if (review.summary) {
            await github.postSummaryComment(formatCommentBody(review.summary), review.model, review.tokenUsage);
            console.log('✅ 概要コメントをIssueコメントとして投稿しました');
        }
        // 行コメントを準備
        const reviewComments = review.lineComments.map(comment => {
            const tagEmoji = {
                critical: '🔴',
                performance: '⚡',
                style: '✏️'
            };
            let body = `${tagEmoji[comment.tag]} **[${comment.tag.toUpperCase()}]**\n\n${formatCommentBody(comment.message)}`;
            if (comment.suggestion) {
                body += `\n\n**改善案:**\n${comment.suggestion}`;
            }
            return {
                path: comment.path,
                line: comment.line,
                body,
            };
        });
        // 必ずPRレビューとして投稿（空配列でもレビュー済み状態にするため）
        await github.postReviewComments(reviewComments, review.lineComments);
        if (reviewComments.length > 0) {
            console.log(`✅ ${reviewComments.length} 件の行コメントをPRレビューとして投稿しました`);
        }
        else {
            console.log('✅ 行コメントはありませんでした。サマリーコメントのみ投稿しました');
        }
        console.log('🎉 AI PR Review が完了しました！');
    }
    catch (error) {
        console.error('❌ AI PR Review でエラーが発生しました:', error);
        process.exit(1);
    }
}
main().catch(error => {
    console.error('❌ 予期しないエラーが発生しました:', error);
    process.exit(1);
});
