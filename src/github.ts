// path: scripts/review/src/github.ts
import { Octokit } from '@octokit/rest';
import { minimatch } from 'minimatch';
import type { Config } from './config.js';
import type { LineComment, TokenUsage } from './openai.js';

export interface PRInfo {
  title: string;
  body: string | null;
  labels: string[];
  files: PRFile[];
}

export interface PRFile {
  filename: string;
  status: string;
  patch?: string;
  contents?: string;
}

export interface ReviewComment {
  path: string;
  line?: number;
  body: string;
  side?: 'LEFT' | 'RIGHT';
  start_line?: number;
  start_side?: 'LEFT' | 'RIGHT';
}

export class GitHubService {
  private octokit: Octokit;
  private config: Config;
  private existingCommentId: number | null = null;

  constructor(config: Config) {
    this.config = config;
    this.octokit = new Octokit({ auth: config.githubToken });
  }

  async getPRInfo(): Promise<PRInfo> {
    const { data: pr } = await this.octokit.rest.pulls.get({
      owner: this.config.owner,
      repo: this.config.repo,
      pull_number: this.config.pullNumber,
    });

    const { data: files } = await this.octokit.rest.pulls.listFiles({
      owner: this.config.owner,
      repo: this.config.repo,
      pull_number: this.config.pullNumber,
    });

    const targetFiles = files.filter(file => !this.isExcludedFile(file.filename));

    const prFiles: PRFile[] = [];
    for (const file of targetFiles) {
      const prFile: PRFile = {
        filename: file.filename,
        status: file.status,
        patch: file.patch,
      };

      if (this.shouldFetchFullContent(file.filename, file.patch)) {
        try {
          const { data: content } = await this.octokit.rest.repos.getContent({
            owner: this.config.owner,
            repo: this.config.repo,
            path: file.filename,
            ref: pr.head.sha,
          });

          if ('content' in content && content.content) {
            prFile.contents = Buffer.from(content.content, 'base64').toString('utf-8');
          }
        } catch (error) {
          console.warn(`Failed to fetch content for ${file.filename}:`, error);
        }
      }

      prFiles.push(prFile);
    }

    return {
      title: pr.title,
      body: pr.body,
      labels: pr.labels.map(label => typeof label === 'string' ? label : label.name || ''),
      files: prFiles,
    };
  }

  private isExcludedFile(filename: string): boolean {
    const patterns = this.config.excludePatterns
      .map(pattern => pattern.trim())
      .filter(pattern => pattern.length > 0);

    for (const pattern of patterns) {
      if (minimatch(filename, pattern, { dot: true })) {
        console.log(`⏭️  除外パターン一致のためスキップ: ${filename} (pattern: ${pattern})`);
        return true;
      }
    }

    return false;
  }

  private shouldFetchFullContent(filename: string, patch?: string): boolean {
    if (!patch) return false;
    
    const isSmallFile = patch.split('\n').length < 50;
    const isConfigFile = !!filename.match(/\.(gradle|json|xml|yml|yaml|properties)$/);
    const isKotlinFile = filename.endsWith('.kt');
    
    return isSmallFile || isConfigFile || (isKotlinFile && patch.split('\n').length < 100);
  }

  async postSummaryComment(content: string, model: string, tokenUsage: TokenUsage): Promise<void> {
    await this.deleteExistingSummaryComment();

    // 改行が適切に表示されるようにフォーマット
    const formattedContent = this.formatSummaryContent(content);
    const footer = this.buildReviewFooter(model, tokenUsage);

    const { data: comment } = await this.octokit.rest.issues.createComment({
      owner: this.config.owner,
      repo: this.config.repo,
      issue_number: this.config.pullNumber,
      body: `## 🤖 AI レビュー結果\n\n${formattedContent}\n\n${footer}`,
    });

    this.existingCommentId = comment.id;
  }

  private buildReviewFooter(model: string, tokenUsage: TokenUsage): string {
    return `---\n| 🤖モデル | 💰トークン |\n|:---|:---|\n| \`${model}\` | ${tokenUsage.promptTokens.toLocaleString()} in / ${tokenUsage.completionTokens.toLocaleString()} out |`;
  }

  async postReviewWithSummary(summary: string, comments: ReviewComment[]): Promise<void> {
    console.log('🗑️  既存レビューの削除を開始...');
    await this.deleteExistingReviews();

    console.log('📝 フォーマット前の概要コメント:', summary);
    const formattedSummary = this.formatSummaryContent(summary);
    console.log('📝 フォーマット後の概要コメント:', formattedSummary);
    
    const reviewBody = formattedSummary 
      ? `## 🤖 AI レビュー結果\n\n${formattedSummary}`
      : `## 🤖 AI レビュー結果\n\nレビューを完了しました。`;

    console.log('📝 最終的なレビューボディ長:', reviewBody.length);

    await this.octokit.rest.pulls.createReview({
      owner: this.config.owner,
      repo: this.config.repo,
      pull_number: this.config.pullNumber,
      event: 'COMMENT',
      body: reviewBody,
      comments,
    });
  }

  private formatSummaryContent(content: string): string {
    if (!content) return '';
    
    console.log('🔍 フォーマット処理開始 - 元の長さ:', content.length);
    
    const formatted = content
      .trim()
      // **見出し** の後に改行を確保
      .replace(/(\*\*[^*]+\*\*)\s*/g, '$1\n\n')
      // - リスト項目の前に改行を確保
      .replace(/([^\n])\s*-\s+/g, '$1\n\n- ')
      // 行頭の - の前の余分な改行を調整
      .replace(/\n{3,}-/g, '\n\n-')
      // 連続する改行を制限
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    
    console.log('🔍 フォーマット処理完了 - 処理後の長さ:', formatted.length);
    
    return formatted;
  }

  async postReviewComments(comments: ReviewComment[], originalComments?: LineComment[]): Promise<void> {
    console.log('📝 PRレビューを投稿中...');
    
    if (comments.length > 0) {
      // 行コメント用に実際の差分行番号を取得して調整
      const validComments = await this.validateAndFixComments(comments, originalComments);
      
      if (validComments.length > 0) {
        console.log(`📝 ${validComments.length}個の行コメントを投稿します`);
        await this.octokit.rest.pulls.createReview({
          owner: this.config.owner,
          repo: this.config.repo,
          pull_number: this.config.pullNumber,
          event: 'COMMENT',
          comments: validComments,
        });
      } else {
        // 有効な行コメントがない場合はボディにまとめる
        console.log('📝 有効な行コメントがないため、レビューボディに投稿します');
        let reviewBody = '## 🤖 コードレビューコメント\n\n';
        
        for (const comment of comments) {
          reviewBody += `### ${comment.path}\n`;
          reviewBody += `${comment.body}\n\n`;
        }
        
        await this.octokit.rest.pulls.createReview({
          owner: this.config.owner,
          repo: this.config.repo,
          pull_number: this.config.pullNumber,
          event: 'COMMENT',
          body: reviewBody,
        });
      }
    }

    console.log('✅ PRレビュー投稿完了');
  }

  private async validateAndFixComments(comments: ReviewComment[], originalComments?: LineComment[]): Promise<ReviewComment[]> {
    const validComments: ReviewComment[] = [];
    
    // PRのファイル情報を取得（差分行情報を含む）
    const { data: files } = await this.octokit.rest.pulls.listFiles({
      owner: this.config.owner,
      repo: this.config.repo,
      pull_number: this.config.pullNumber,
    });
    
    for (let i = 0; i < comments.length; i++) {
      const comment = comments[i];
      const originalComment = originalComments?.[i];
      
      const file = files.find(f => f.filename === comment.path);
      if (!file || !file.patch) {
        console.log(`⚠️  ${comment.path}: 差分が見つからないため行コメントをスキップ`);
        continue;
      }
      
      // 行番号が指定されている場合のみ処理
      if (comment.line === undefined) {
        console.log(`⚠️  ${comment.path}: 行番号が未指定のためスキップ`);
        continue;
      }
      
      // コメント内容に基づいて最適な行番号を特定
      const optimalLine = await this.findOptimalLineForComment(file, originalComment || comment);
      if (optimalLine) {
        const reviewComment: ReviewComment = {
          ...comment,
          line: optimalLine.endLine,
          side: 'RIGHT',
        };
        
        // 範囲コメントの場合はstart_lineを設定
        if (optimalLine.startLine !== optimalLine.endLine) {
          reviewComment.start_line = optimalLine.startLine;
          reviewComment.start_side = 'RIGHT';
        }
        
        validComments.push(reviewComment);
        
        if (optimalLine.startLine !== optimalLine.endLine) {
          console.log(`✅ ${comment.path}:${comment.line} -> ${optimalLine.startLine}-${optimalLine.endLine} (範囲コメント)`);
        } else {
          console.log(`✅ ${comment.path}:${comment.line} -> ${optimalLine.endLine} (内容マッチング)`);
        }
      } else {
        console.log(`⚠️  ${comment.path}:${comment.line}: 適切な行が見つからないためスキップ`);
      }
    }
    
    return validComments;
  }
  
  private findValidLineInDiff(patch: string, targetLine: number): number | null {
    const lines = patch.split('\n');
    let currentLine = 0;
    
    for (const line of lines) {
      // 差分のヘッダー行から開始行番号を取得
      const headerMatch = line.match(/^@@ -\d+,\d+ \+(\d+),\d+ @@/);
      if (headerMatch) {
        currentLine = parseInt(headerMatch[1]) - 1; // 次の行から開始
        continue;
      }
      
      // 追加行または変更行の場合
      if (line.startsWith('+') || line.startsWith(' ')) {
        currentLine++;
        
        // targetLine 付近の行を返す（±5行の範囲で）
        if (Math.abs(currentLine - targetLine) <= 5) {
          return currentLine;
        }
      }
    }
    
    // 見つからない場合は最初の有効な行を返す
    return this.findFirstValidLineInDiff(patch);
  }
  
  private findFirstValidLineInDiff(patch: string): number | null {
    const lines = patch.split('\n');
    let currentLine = 0;
    
    for (const line of lines) {
      const headerMatch = line.match(/^@@ -\d+,\d+ \+(\d+),\d+ @@/);
      if (headerMatch) {
        currentLine = parseInt(headerMatch[1]) - 1;
        continue;
      }
      
      if (line.startsWith('+') || line.startsWith(' ')) {
        currentLine++;
        return currentLine;
      }
    }
    
    return null;
  }

  private async findOptimalLineForComment(file: any, comment: ReviewComment | LineComment): Promise<{startLine: number, endLine: number} | null> {
    if (!file.patch) return null;
    
    // ファイル内容を取得
    let fullContent = '';
    if (file.contents_url) {
      try {
        const { data: content } = await this.octokit.rest.repos.getContent({
          owner: this.config.owner,
          repo: this.config.repo,
          path: file.filename,
          ref: `refs/pull/${this.config.pullNumber}/head`,
        });
        
        if ('content' in content && content.content) {
          fullContent = Buffer.from(content.content, 'base64').toString('utf-8');
        }
      } catch (error) {
        console.warn(`ファイル内容の取得に失敗: ${file.filename}`, error);
      }
    }
    
    // コメント内容からキーワードを抽出
    const messageText = 'message' in comment ? comment.message : comment.body;
    const keywords = this.extractKeywords(messageText);
    console.log(`🔍 ${file.filename} でキーワード検索: [${keywords.join(', ')}]`);
    
    // 差分行の情報を取得
    const diffLines = this.parseDiffLines(file.patch);
    
    // キーワードに基づいて最適な行を検索
    const bestMatch = this.findBestMatchInDiff(diffLines, keywords, fullContent);
    
    return bestMatch;
  }

  private extractKeywords(message: string): string[] {
    const keywords: string[] = [];
    
    // APIパラメータ名
    const apiParams = message.match(/\b(max_completion_tokens|max_tokens|temperature|model)\b/g);
    if (apiParams) keywords.push(...apiParams);
    
    // Kotlin/Java キーワード
    const kotlinKeywords = message.match(/\b(data object|sealed interface|object|class|interface|import)\b/g);
    if (kotlinKeywords) keywords.push(...kotlinKeywords);
    
    // 関数名や変数名（キャメルケース、スネークケース）
    const identifiers = message.match(/\b[a-zA-Z][a-zA-Z0-9_]*[a-zA-Z0-9]\b/g);
    if (identifiers) {
      // 長めの識別子のみ抽出（3文字以上）
      keywords.push(...identifiers.filter(id => id.length >= 3));
    }
    
    // ファイルパスの一部
    const pathParts = message.match(/\b\w+\.(ts|kt|js|java|xml)\b/g);
    if (pathParts) keywords.push(...pathParts);
    
    return [...new Set(keywords)]; // 重複除去
  }

  private parseDiffLines(patch: string): Array<{lineNumber: number, content: string, type: 'add' | 'context' | 'remove'}> {
    const lines = patch.split('\n');
    const diffLines: Array<{lineNumber: number, content: string, type: 'add' | 'context' | 'remove'}> = [];
    let currentLine = 0;
    
    for (const line of lines) {
      const headerMatch = line.match(/^@@ -\d+,\d+ \+(\d+),\d+ @@/);
      if (headerMatch) {
        currentLine = parseInt(headerMatch[1]) - 1;
        continue;
      }
      
      if (line.startsWith('+')) {
        currentLine++;
        diffLines.push({
          lineNumber: currentLine,
          content: line.substring(1),
          type: 'add'
        });
      } else if (line.startsWith(' ')) {
        currentLine++;
        diffLines.push({
          lineNumber: currentLine,
          content: line.substring(1),
          type: 'context'
        });
      } else if (line.startsWith('-')) {
        // 削除行は行番号を進めない
        diffLines.push({
          lineNumber: currentLine,
          content: line.substring(1),
          type: 'remove'
        });
      }
    }
    
    return diffLines;
  }

  private findBestMatchInDiff(
    diffLines: Array<{lineNumber: number, content: string, type: 'add' | 'context' | 'remove'}>, 
    keywords: string[],
    fullContent: string
  ): {startLine: number, endLine: number} | null {
    
    let bestMatch: {startLine: number, endLine: number, score: number} | null = null;
    
    // 各行でキーワードマッチングを行う（追加行を優先、次にコンテキスト行）
    for (let i = 0; i < diffLines.length; i++) {
      const line = diffLines[i];
      if (line.type === 'remove') continue; // 削除行は無視
      
      let score = 0;
      for (const keyword of keywords) {
        if (line.content.toLowerCase().includes(keyword.toLowerCase())) {
          score += keyword.length; // 長いキーワードほど高スコア
          
          // 追加行（修正後のコード）により高いスコアを付与
          if (line.type === 'add') {
            score += keyword.length * 0.5; // 50%ボーナス
          }
        }
      }
      
      if (score > 0) {
        // 変更セットを考慮した範囲特定
        const range = this.expandToChangeContext(diffLines, i, keywords);
        
        if (!bestMatch || score > bestMatch.score) {
          bestMatch = {
            startLine: range.startLine,
            endLine: range.endLine,
            score
          };
        }
      }
    }
    
    // マッチしなかった場合は差分の最初の追加行を返す
    if (!bestMatch) {
      const firstAddLine = diffLines.find(line => line.type === 'add');
      if (firstAddLine) {
        return {
          startLine: firstAddLine.lineNumber,
          endLine: firstAddLine.lineNumber
        };
      }
      
      // 追加行がない場合は最初の有効行
      const firstValidLine = diffLines.find(line => line.type !== 'remove');
      if (firstValidLine) {
        return {
          startLine: firstValidLine.lineNumber,
          endLine: firstValidLine.lineNumber
        };
      }
    }
    
    return bestMatch ? {startLine: bestMatch.startLine, endLine: bestMatch.endLine} : null;
  }

  private expandToChangeContext(
    diffLines: Array<{lineNumber: number, content: string, type: 'add' | 'context' | 'remove'}>,
    centerIndex: number,
    keywords: string[]
  ): {startLine: number, endLine: number} {
    
    let startIndex = centerIndex;
    let endIndex = centerIndex;
    
    // 変更ブロック全体を特定（追加行中心で前後のコンテキストを含む）
    const maxExpand = 3;
    
    // 後方拡張
    for (let i = centerIndex + 1; i < Math.min(centerIndex + maxExpand + 1, diffLines.length); i++) {
      const line = diffLines[i];
      if (line.type === 'remove') continue;
      
      // 追加行またはキーワードマッチする行は拡張対象
      if (line.type === 'add' || this.isRelatedLine(diffLines[centerIndex].content, line.content, keywords)) {
        endIndex = i;
      } else {
        break;
      }
    }
    
    // 前方拡張
    for (let i = centerIndex - 1; i >= Math.max(centerIndex - maxExpand, 0); i--) {
      const line = diffLines[i];
      if (line.type === 'remove') continue;
      
      if (line.type === 'add' || this.isRelatedLine(diffLines[centerIndex].content, line.content, keywords)) {
        startIndex = i;
      } else {
        break;
      }
    }
    
    return {
      startLine: diffLines[startIndex].lineNumber,
      endLine: diffLines[endIndex].lineNumber
    };
  }

  private expandToRelatedLines(
    diffLines: Array<{lineNumber: number, content: string, type: 'add' | 'context' | 'remove'}>,
    centerIndex: number,
    keywords: string[]
  ): {startLine: number, endLine: number} {
    
    let startIndex = centerIndex;
    let endIndex = centerIndex;
    
    // 関連する行を前後に拡張（最大5行）
    const maxExpand = 3;
    
    // 後方拡張
    for (let i = centerIndex + 1; i < Math.min(centerIndex + maxExpand + 1, diffLines.length); i++) {
      const line = diffLines[i];
      if (line.type === 'remove') continue;
      
      // 同じレベルのインデントまたは関連キーワードがある場合は拡張
      if (this.isRelatedLine(diffLines[centerIndex].content, line.content, keywords)) {
        endIndex = i;
      } else {
        break;
      }
    }
    
    // 前方拡張
    for (let i = centerIndex - 1; i >= Math.max(centerIndex - maxExpand, 0); i--) {
      const line = diffLines[i];
      if (line.type === 'remove') continue;
      
      if (this.isRelatedLine(diffLines[centerIndex].content, line.content, keywords)) {
        startIndex = i;
      } else {
        break;
      }
    }
    
    return {
      startLine: diffLines[startIndex].lineNumber,
      endLine: diffLines[endIndex].lineNumber
    };
  }

  private isRelatedLine(centerLine: string, testLine: string, keywords: string[]): boolean {
    // インデントレベルが同じまたは1レベル違い
    const centerIndent = centerLine.match(/^\s*/)?.[0].length || 0;
    const testIndent = testLine.match(/^\s*/)?.[0].length || 0;
    
    if (Math.abs(centerIndent - testIndent) <= 2) {
      return true;
    }
    
    // キーワードが共通している
    for (const keyword of keywords) {
      if (testLine.toLowerCase().includes(keyword.toLowerCase())) {
        return true;
      }
    }
    
    return false;
  }

  private async deleteExistingSummaryComment(): Promise<void> {
    try {
      const { data: comments } = await this.octokit.rest.issues.listComments({
        owner: this.config.owner,
        repo: this.config.repo,
        issue_number: this.config.pullNumber,
      });

      const botComments = comments.filter(comment => 
        comment.user?.login === 'rumahbot' || comment.body?.includes('🤖 AI レビュー結果')
      );

      for (const comment of botComments) {
        await this.octokit.rest.issues.deleteComment({
          owner: this.config.owner,
          repo: this.config.repo,
          comment_id: comment.id,
        });
      }
    } catch (error) {
      console.warn('Failed to delete existing summary comments:', error);
    }
  }

  private async deleteExistingReviews(): Promise<void> {
    try {
      console.log('🔍 既存レビューを検索中...');
      const { data: reviews } = await this.octokit.rest.pulls.listReviews({
        owner: this.config.owner,
        repo: this.config.repo,
        pull_number: this.config.pullNumber,
      });

      console.log(`📋 見つかったレビュー数: ${reviews.length}`);

      const botReviews = reviews.filter(review => {
        const isRumahbot = review.user?.login === 'rumahbot';
        const hasMarker = review.body?.includes('🤖 AI レビュー');
        console.log(`レビューID ${review.id}: ユーザー=${review.user?.login}, マーカー=${hasMarker}`);
        return isRumahbot || hasMarker;
      });

      console.log(`🎯 削除対象レビュー数: ${botReviews.length}`);

      for (const review of botReviews) {
        console.log(`🗑️  レビュー処理中: ID=${review.id}, ユーザー=${review.user?.login}, 状態=${review.state}`);
        
        // レビューがまだアクティブな場合は却下する
        if (review.state === 'PENDING' || review.state === 'COMMENTED') {
          try {
            await this.octokit.rest.pulls.dismissReview({
              owner: this.config.owner,
              repo: this.config.repo,
              pull_number: this.config.pullNumber,
              review_id: review.id,
              message: 'AI レビューの更新により古いレビューを却下',
            });
            console.log(`✅ レビュー却下成功: ${review.id}`);
          } catch (error) {
            console.warn(`❌ レビュー却下失敗 ${review.id}:`, error);
          }
        }
        
        // レビュー内のコメントを削除
        try {
          const { data: comments } = await this.octokit.rest.pulls.listCommentsForReview({
            owner: this.config.owner,
            repo: this.config.repo,
            pull_number: this.config.pullNumber,
            review_id: review.id,
          });

          console.log(`📝 レビュー${review.id}のコメント数: ${comments.length}`);

          for (const comment of comments) {
            if (!comment.in_reply_to_id) {
              try {
                await this.octokit.rest.pulls.deleteReviewComment({
                  owner: this.config.owner,
                  repo: this.config.repo,
                  comment_id: comment.id,
                });
                console.log(`✅ コメント削除成功: ${comment.id}`);
              } catch (error) {
                console.warn(`❌ コメント削除失敗 ${comment.id}:`, error);
              }
            }
          }
        } catch (error) {
          console.warn(`❌ レビューコメント取得失敗 ${review.id}:`, error);
        }
      }
    } catch (error) {
      console.warn('❌ 既存レビュー削除処理でエラー:', error);
    }
  }

}
