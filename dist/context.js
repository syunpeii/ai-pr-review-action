// path: scripts/review/src/context.ts
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse } from 'smol-toml';
export class ContextBuilder {
    truncatedDueToLimit = false;
    filePriorities = {};
    includePrTitle;
    includePrBody;
    includePrLabels;
    constructor(filePriorities, includePrTitle, includePrBody, includePrLabels) {
        this.filePriorities = filePriorities;
        this.includePrTitle = includePrTitle;
        this.includePrBody = includePrBody;
        this.includePrLabels = includePrLabels;
    }
    buildPrompt(prInfo, maxTokens) {
        this.truncatedDueToLimit = false;
        const basePrompt = this.buildBasePrompt(prInfo);
        const estimatedTokens = this.estimateTokens(basePrompt);
        // 通常は全体を使用、上限に近い場合のみ制限
        if (estimatedTokens <= maxTokens * 0.8) {
            return { prompt: basePrompt, wasTruncated: false };
        }
        // トークン上限に近いため入力を削減
        this.truncatedDueToLimit = true;
        const truncatedPrompt = this.buildTruncatedPrompt(prInfo, maxTokens * 0.8);
        return { prompt: truncatedPrompt, wasTruncated: true };
    }
    getLibsVersionsContent() {
        const libsVersionsPath = join(process.cwd(), 'gradle/libs.versions.toml');
        if (!existsSync(libsVersionsPath)) {
            return '';
        }
        try {
            const content = readFileSync(libsVersionsPath, 'utf8');
            const parsed = parse(content);
            const versions = parsed.versions;
            const kotlinVersion = versions?.kotlin ?? 'unknown';
            return `\n\n# プロジェクト情報\n\n**Kotlinバージョン**: ${kotlinVersion}\n**その他の主要ライブラリ**: ${JSON.stringify(versions || {}, null, 2)}\n\n`;
        }
        catch (error) {
            console.warn('⚠️  Failed to read libs.versions.toml:', error);
            return '';
        }
    }
    buildBasePrompt(prInfo) {
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
    buildTruncatedPrompt(prInfo, maxTokens) {
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
                }
                else {
                    prompt += `## ${file.filename}\n\n⚠️ 変更内容が大きすぎるため省略されました。\n\n`;
                }
                continue;
            }
            prompt += fileSection;
            remainingTokens -= sectionTokens;
            if (remainingTokens <= 0)
                break;
        }
        return prompt;
    }
    buildFileSection(file) {
        let section = `## ${file.filename}\n\n`;
        if (file.patch) {
            section += `\`\`\`diff\n${file.patch}\n\`\`\`\n\n`;
        }
        if (file.contents && this.isSmallFile(file.contents)) {
            section += `**ファイル全体**:\n\`\`\`${this.getLanguageFromFilename(file.filename)}\n${file.contents}\n\`\`\`\n\n`;
        }
        return section;
    }
    buildDiffOnlySection(file) {
        let section = `## ${file.filename}\n\n`;
        if (file.patch) {
            section += `\`\`\`diff\n${file.patch}\n\`\`\`\n\n`;
        }
        return section;
    }
    prioritizeFiles(files) {
        return files.sort((a, b) => {
            const aPriority = this.getFilePriority(a.filename, this.filePriorities);
            const bPriority = this.getFilePriority(b.filename, this.filePriorities);
            return bPriority - aPriority;
        });
    }
    getFilePriority(filename, priorities) {
        const ext = filename.split('.').pop()?.toLowerCase();
        if (!ext)
            return 1;
        // 設定ファイルから優先度を取得
        if (priorities[ext])
            return priorities[ext];
        // gradle.kts など複合拡張子のチェック
        if (filename.match(/\.gradle\.kts$/))
            return priorities['gradle'] || 8;
        if (filename.match(/\.(yml|yaml)$/))
            return priorities['yml'] || 5;
        return 3; // デフォルト
    }
    getLanguageFromFilename(filename) {
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
    isSmallFile(contents) {
        return contents.split('\n').length < 100;
    }
    estimateTokens(text) {
        return Math.ceil(text.length / 3.5);
    }
}
