// path: scripts/review/src/context.ts
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse } from 'smol-toml';
import type { PRInfo } from './github.js';

export class ContextBuilder {
  private truncatedDueToLimit = false;
  private filePriorities: Record<string, number> = {};
  private includePrTitle: boolean;
  private includePrBody: boolean;
  private includePrLabels: boolean;

  constructor(
    filePriorities: Record<string, number>,
    includePrTitle: boolean,
    includePrBody: boolean,
    includePrLabels: boolean,
  ) {
    this.filePriorities = filePriorities;
    this.includePrTitle = includePrTitle;
    this.includePrBody = includePrBody;
    this.includePrLabels = includePrLabels;
  }

  buildPrompt(prInfo: PRInfo, maxInputTokens?: number): { prompt: string; wasTruncated: boolean } {
    this.truncatedDueToLimit = false;
    const basePrompt = this.buildBasePrompt(prInfo);

    if (maxInputTokens === undefined) {
      return { prompt: basePrompt, wasTruncated: false };
    }

    const estimatedTokens = this.estimateTokens(basePrompt);
    
    // 通常は全体を使用、上限を超える場合のみ制限
    if (estimatedTokens <= maxInputTokens) {
      return { prompt: basePrompt, wasTruncated: false };
    }

    // 入力トークン上限を超えるため入力を削減
    this.truncatedDueToLimit = true;
    const truncatedPrompt = this.buildTruncatedPrompt(prInfo, maxInputTokens);
    return { prompt: truncatedPrompt, wasTruncated: true };
  }

  private getLibsVersionsContent(): string {
    const libsVersionsPath = join(process.cwd(), 'gradle/libs.versions.toml');
    
    if (!existsSync(libsVersionsPath)) {
      return '';
    }

    try {
      const content = readFileSync(libsVersionsPath, 'utf8');
      const parsed = parse(content);
      const versions = parsed.versions as Record<string, unknown> | undefined;
      const kotlinVersion = versions?.kotlin ?? 'unknown';
      
      return `\n\n# プロジェクト情報\n\n**Kotlinバージョン**: ${kotlinVersion}\n**その他の主要ライブラリ**: ${JSON.stringify(versions || {}, null, 2)}\n\n`;
    } catch (error) {
      console.warn('⚠️  Failed to read libs.versions.toml:', error);
      return '';
    }
  }

  private buildBasePrompt(prInfo: PRInfo): string {
    let prompt = `# PR情報\n\n`;
    if (this.includePrTitle) {
      prompt += `**タイトル**: ${prInfo.title}\n\n`;
    }
    
    if (this.includePrBody && prInfo.body) {
      prompt += `**説明**:\n${prInfo.body}\n\n`;
    }

    if (this.includePrLabels && prInfo.labels.length > 0) {
      prompt += `**ラベル**: ${prInfo.labels.join(', ')}\n\n`;
    }

    // libs.versions.tomlの情報を追加
    prompt += this.getLibsVersionsContent();

    prompt += `# 変更ファイル一覧\n\n`;
    for (const file of prInfo.files) {
      prompt += `- ${file.filename} (${file.status})\n`;
    }

    prompt += `\n# ファイル変更詳細\n\n`;
    
    for (const file of prInfo.files) {
      prompt += `## ${file.filename}\n\n`;
      
      if (file.patch) {
        prompt += `**diff**:\n\`\`\`diff\n${file.patch}\n\`\`\`\n\n`;
      }

      if (file.contents) {
        prompt += `**ファイル全体**:\n\`\`\`${this.getLanguageFromFilename(file.filename)}\n${file.contents}\n\`\`\`\n\n`;
      }
    }

    return prompt;
  }

  private buildTruncatedPrompt(prInfo: PRInfo, maxTokens: number): string {
    let prompt = `# PR情報\n\n`;
    if (this.includePrTitle) {
      prompt += `**タイトル**: ${prInfo.title}\n\n`;
    }
    
    if (this.includePrBody && prInfo.body && prInfo.body.length < 500) {
      prompt += `**説明**:\n${prInfo.body}\n\n`;
    }

    if (this.includePrLabels && prInfo.labels.length > 0) {
      prompt += `**ラベル**: ${prInfo.labels.join(', ')}\n\n`;
    }

    // libs.versions.tomlの情報を追加（truncated版でも重要）
    prompt += this.getLibsVersionsContent();

    prompt += `# 変更ファイル\n\n`;
    
    const sortedFiles = this.prioritizeFiles(prInfo.files);
    let remainingTokens = maxTokens - this.estimateTokens(prompt);

    for (const file of sortedFiles) {
      const fileSection = this.buildFileSection(file);
      const sectionTokens = this.estimateTokens(fileSection);
      
      if (sectionTokens > remainingTokens) {
        // 大きなファイルは差分のみ表示（ファイル全体を除外）
        const diffOnlySection = this.buildDiffOnlySection(file);
        const diffTokens = this.estimateTokens(diffOnlySection);
        
        if (diffTokens <= remainingTokens) {
          prompt += diffOnlySection;
          remainingTokens -= diffTokens;
        } else {
          prompt += `## ${file.filename}\n\n⚠️ 変更内容が大きすぎるため省略されました。\n\n`;
        }
        continue;
      }

      prompt += fileSection;
      remainingTokens -= sectionTokens;

      if (remainingTokens <= 0) break;
    }

    return prompt;
  }

  private buildFileSection(file: { filename: string; status: string; patch?: string; contents?: string }): string {
    let section = `## ${file.filename}\n\n`;
    
    if (file.patch) {
      section += `\`\`\`diff\n${file.patch}\n\`\`\`\n\n`;
    }

    if (file.contents && this.isSmallFile(file.contents)) {
      section += `**ファイル全体**:\n\`\`\`${this.getLanguageFromFilename(file.filename)}\n${file.contents}\n\`\`\`\n\n`;
    }

    return section;
  }

  private buildDiffOnlySection(file: { filename: string; patch?: string }): string {
    let section = `## ${file.filename}\n\n`;
    
    if (file.patch) {
      section += `\`\`\`diff\n${file.patch}\n\`\`\`\n\n`;
    }

    return section;
  }

  private prioritizeFiles(files: any[]): any[] {
    return files.sort((a, b) => {
      const aPriority = this.getFilePriority(a.filename, this.filePriorities);
      const bPriority = this.getFilePriority(b.filename, this.filePriorities);
      return bPriority - aPriority;
    });
  }

  private getFilePriority(filename: string, priorities: Record<string, number>): number {
    const ext = filename.split('.').pop()?.toLowerCase();
    if (!ext) return 1;
    
    // 設定ファイルから優先度を取得
    if (priorities[ext]) return priorities[ext];
    
    // gradle.kts など複合拡張子のチェック
    if (filename.match(/\.gradle\.kts$/)) return priorities['gradle'] || 8;
    if (filename.match(/\.(yml|yaml)$/)) return priorities['yml'] || 5;
    
    return 3; // デフォルト
  }

  private getLanguageFromFilename(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'kt': return 'kotlin';
      case 'java': return 'java';
      case 'gradle': return 'gradle';
      case 'kts': return 'kotlin';
      case 'xml': return 'xml';
      case 'json': return 'json';
      case 'yml':
      case 'yaml': return 'yaml';
      case 'md': return 'markdown';
      default: return '';
    }
  }

  private isSmallFile(contents: string): boolean {
    return contents.split('\n').length < 100;
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 3.5);
  }
}
