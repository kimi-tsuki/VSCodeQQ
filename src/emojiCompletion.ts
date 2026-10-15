import * as vscode from 'vscode';
import type { QQApp } from './extension';
import type { SlashInvocation } from './slashCommands';

interface EmojiItem extends vscode.CompletionItem { emojiId: string; document: vscode.TextDocument; invocation: SlashInvocation; }
export class EmojiCompletion implements vscode.CompletionItemProvider {
  constructor(private app: QQApp) {}
  async provideCompletionItems(doc: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.CompletionItem[]> {
    const region = this.app.native.region(doc);
    if (!region || doc.offsetAt(position) < region.start) return [];
    const before = doc.lineAt(position.line).text.slice(0, position.character);
    const match = /([!！])([^!！\s]*)$/.exec(before);
    if (!match || doc.offsetAt(new vscode.Position(position.line, match.index)) < region.start) return [];
    const invocation = this.app.slash.capture(doc.uri); if (!invocation) return [];
    const version = doc.version;
    const entries = await this.app.emojis.inlineEntries();
    if (token.isCancellationRequested || version !== doc.version || invocation.generation !== this.app.session.generation || invocation.account !== this.app.store?.selfId) return [];
    return entries.map((entry, index) => {
      const item = new vscode.CompletionItem({ label: entry.label, description: entry.category }, vscode.CompletionItemKind.File) as EmojiItem;
      item.emojiId = entry.id; item.document = doc; item.invocation = invocation;
      item.range = new vscode.Range(position.line, match.index, position.line, position.character);
      item.insertText = ''; item.filterText = match[1] + entry.label.replace(/\s/g, ''); item.sortText = String(index).padStart(4, '0');
      item.detail = `${entry.icon ?? ''} ${entry.category} · Enter 插入占位符，不发送`;
      item.documentation = new vscode.MarkdownString('选择后插入草稿；需要发送时再按 Enter。');
      item.command = { command: 'qq.insertInlineEmoji', title: '插入表情', arguments: [entry.id, invocation] };
      return item;
    });
  }
  async resolveCompletionItem(item: EmojiItem, token: vscode.CancellationToken): Promise<vscode.CompletionItem> {
    if (token.isCancellationRequested || item.invocation.generation !== this.app.session.generation || item.invocation.account !== this.app.store?.selfId) return item;
    const preview = await this.app.emojis.inlinePreview(item.emojiId, item.document);
    if (!token.isCancellationRequested && item.invocation.generation === this.app.session.generation && preview) item.documentation = preview;
    return item;
  }
  async insert(id: string, invocation: SlashInvocation): Promise<void> {
    const store = this.app.store, captured = this.app.session.capture();
    const editor = vscode.window.activeTextEditor;
    const key = editor && this.app.transcript?.key(editor.document.uri);
    const check = () => {
      if (!store || !key || !captured.current() || store !== this.app.store || captured.generation !== invocation.generation || store.selfId !== invocation.account || editor?.document.uri.toString() !== invocation.uri || vscode.window.activeTextEditor !== editor) throw new Error('会话或连接已变化，请重新选择表情');
    };
    check();
    await this.app.emojis.insertInline(id, key!, check);
  }
}
