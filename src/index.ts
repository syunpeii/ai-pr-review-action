// path: scripts/review/src/index.ts
import { loadConfig } from './config.js';
import { GitHubService, type ReviewComment } from './github.js';
import { OpenAIService } from './openai.js';
import { ContextBuilder } from './context.js';
import { runReview } from './review-runner.js';
import { buildReviewMetadata } from './summary.js';

function formatCommentBody(content: string): string {
  if (!content) return '';
  
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

async function main(): Promise<void> {
  try {
    console.log('🚀 AI PR Review を開始します...');
    
    const config = loadConfig();
    console.log(`📋 PR #${config.pullNumber} をレビューします`);
    
    const github = new GitHubService(config);
    const openai = new OpenAIService(config);
    const contextBuilder = new ContextBuilder(
      config.filePriorities,
      config.includePrTitle,
      config.includePrBody,
      config.includePrLabels,
      {
        projectContext: config.projectContext,
        maxPrBodyChars: config.maxPrBodyChars,
      },
    );

    console.log('📥 PR情報を取得中...');
    const prInfo = await github.getPRInfo();
    console.log(`📁 ${prInfo.files.length} ファイルの変更を検出`);

    console.log('🤖 AIレビューを生成中...');
    // verified では検証候補の入力領域を残すため、1回目のコード入力を少し絞る。
    const promptBudget =
      config.reviewMode === 'verified' && config.maxInputTokens !== undefined
        ? Math.max(1, Math.floor(config.maxInputTokens * 0.8))
        : config.maxInputTokens;
    const { prompt, wasTruncated, usage, insufficient } = contextBuilder.buildPrompt(prInfo, promptBudget);

    if (insufficient) {
      const metadata = buildReviewMetadata({
        runStatus: 'not_run',
        usage,
        reason: 'max_input_tokens が小さすぎるため、レビューに必要な入力を確保できませんでした。値を増やしてください。',
      });
      await github.postSummaryComment('', config.openaiModel, { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, metadata);
      console.warn('⚠️  max_input_tokens が小さすぎるためレビューを実施せず、未実施の概要のみ投稿しました');
      return;
    }

    const outcome = await runReview(config, openai, prompt);
    const review = outcome.review;

    // formatCommentBody が太字直後の記号を崩すため、状態表示は整形を通さず付加する
    const metadata = buildReviewMetadata({
      runStatus: outcome.status,
      usage,
      wasTruncated,
    });

    console.log('📝 レビューコメントを投稿中...');

    // 概要コメントを通常のIssueコメントとして投稿
    await github.postSummaryComment(formatCommentBody(review.summary), review.model, review.tokenUsage, metadata);
    console.log('✅ 概要コメントをIssueコメントとして投稿しました');

    // 行コメントを準備
    const reviewComments: ReviewComment[] = review.lineComments.map(comment => {
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
    } else {
      console.log('✅ 行コメントはありませんでした。サマリーコメントのみ投稿しました');
    }

    console.log('🎉 AI PR Review が完了しました！');

  } catch (error) {
    console.error('❌ AI PR Review でエラーが発生しました:', error);
    process.exit(1);
  }
}

main().catch(error => {
  console.error('❌ 予期しないエラーが発生しました:', error);
  process.exit(1);
});
