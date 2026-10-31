import type { ContextUsage, SourceStatus } from './context.js';

export type ReviewRunStatus = 'single' | 'verified' | 'verification_failed' | 'not_run';

export interface ReviewMetadataInput {
  runStatus: ReviewRunStatus;
  usage: ContextUsage;
  wasTruncated?: boolean;
  reason?: string;
}

function describeStatus(status: SourceStatus): string {
  switch (status) {
    case 'none': return '指定なし';
    case 'full': return '反映済み';
    case 'partial': return '一部反映（入力上限により省略あり）';
    case 'excluded_by_config': return '未反映（設定により除外）';
    case 'malformed': return '未反映（追加指示の形式不正）';
    case 'omitted_budget': return '未反映（入力上限）';
  }
}

function describeRunStatus(status: ReviewRunStatus): string {
  switch (status) {
    case 'single': return '通常レビュー（1段階）';
    case 'verified': return '検証付きレビュー（2段階完了）';
    case 'verification_failed': return '検証付きレビュー（1回目のみ実行、検証未完了）';
    case 'not_run': return 'レビュー未実施';
  }
}

// 「反映済み」はモデルへの入力に含めた意味であり、指示への準拠は保証しない
export function buildReviewMetadata(input: ReviewMetadataInput): string {
  const { usage } = input;
  const lines: string[] = [];

  lines.push(`**レビュー方式**: ${describeRunStatus(input.runStatus)}`);
  lines.push('');

  if (input.runStatus === 'verification_failed') {
    lines.push(
      `⚠️ **検証未完了**: 検証が完了しなかったため、未検証の指摘は投稿していません。このPRに問題がないという意味ではありません。${input.reason ? `（理由: ${input.reason}）` : ''}`,
    );
    lines.push('');
  }
  if (input.runStatus === 'not_run') {
    lines.push(`⚠️ **レビュー未実施**: ${input.reason ?? ''}`.trimEnd());
    lines.push('');
  }

  lines.push('**レビューに使用した追加情報**');
  lines.push(`- 案件固有情報：${describeStatus(usage.projectContext)}`);
  lines.push(`- PR 本文の AI レビュー指示：${describeStatus(usage.prInstructions)}`);

  const notes: string[] = [];
  if (usage.prBody === 'partial') notes.push('PR 本文は文字数または入力上限により一部を省略しました。');
  if (usage.prBody === 'omitted_budget') notes.push('PR 本文は入力上限のため含められませんでした。');
  if (usage.prInstructionsMalformed) {
    notes.push('PR 本文の AI レビュー指示ブロックに形式の不正（終了マーカー欠落など）があります。不正な部分は通常本文として扱いました。');
  }
  if (usage.metadataDropped) notes.push('入力上限により、PR ラベル・ライブラリ情報を省略しました。');
  if (input.wasTruncated) {
    notes.push('このPRは大きすぎるため、一部のファイル詳細を省略してレビューを行いました。重要な変更が見落とされている可能性があります。');
  }
  if (notes.length > 0) {
    lines.push('');
    for (const note of notes) lines.push(note, '');
    lines.pop();
  }

  return lines.join('\n');
}
