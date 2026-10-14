import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import { ChatStore } from './store';
import { MediaCache } from './media';
import { AttachmentFiles } from './attachments';
import { imagePreviewMarkup } from './imageHover';
import { configuredCodeLanguage } from './configuration';
import { Chat, Message, Rendered, Span, renderTranscript, splitKey } from './model';

export class Transcript implements vscode.TextDocumentContentProvider, vscode.DocumentLinkProvider, vscode.HoverProvider, vscode.Disposable {
  private emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  readonly rendered = new Map<string, Rendered>();
  private uris = new Map<string, vscode.Uri>();
  private dirty = new Set<string>();
  private timer?: NodeJS.Timeout;
  constructor(readonly store: ChatStore, readonly media: MediaCache, private attachments?: AttachmentFiles) {}
  uri(chat: Chat): vscode.Uri {
    let value = this.uris.get(chat.key);
    if (!value) {
      const name = chat.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
      value = vscode.Uri.from({ scheme: 'qqchat', authority: this.store.selfId, path: `/${chat.type}/${chat.id}/${name}.qqchat` });
      this.uris.set(chat.key, value);
    }
    return value;
  }
  key(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== 'qqchat' || uri.authority !== this.store.selfId) return;
    const parts = uri.path.split('/');
    const key = `${parts[1]}:${parts[2]}`;
    try { splitKey(key); return this.store.chats.has(key) ? key : undefined; } catch { return; }
  }
  provideTextDocumentContent(uri: vscode.Uri): string {
    const key = this.key(uri); const chat = key && this.store.chats.get(key);
    if (!chat || !key) return '// 当前账号中没有这个会话，请从 QQ 列表重新打开。';
    this.uris.set(key, uri);
    const content = renderTranscript(chat, this.store.displayMessages(key), this.store.selfId, configuredCodeLanguage());
    this.rendered.set(key, content); return content.text;
  }
  invalidate(key: string): void {
    this.dirty.add(key);
    if (!this.timer) this.timer = setTimeout(() => {
      this.timer = undefined;
      for (const item of this.dirty) {
        const uri = this.uris.get(item), chat = this.store.chats.get(item);
        if (uri && chat && renderTranscript(chat, this.store.displayMessages(item), this.store.selfId, configuredCodeLanguage()).text !== this.rendered.get(item)?.text) this.emitter.fire(uri);
      }
      this.dirty.clear();
    }, 100);
  }
  messageAt(uri: vscode.Uri, line: number): Message | undefined {
    const key = this.key(uri); if (!key) return;
    const id = this.rendered.get(key)?.messages.get(line);
    return this.store.messages.get(key)?.find(m => m.id === id);
  }
  private range(span: Span): vscode.Range { return new vscode.Range(span.line, span.start, span.line, span.end); }
  private imageArgs(uri: vscode.Uri, span: Span): unknown[] { return [uri.toString(), span.messageId, span.imageIndex]; }
  private command(uri: vscode.Uri, span: Span): vscode.Uri {
    return vscode.Uri.parse(`command:qq.openImage?${encodeURIComponent(JSON.stringify(this.imageArgs(uri, span)))}`);
  }
  provideDocumentLinks(doc: vscode.TextDocument): vscode.DocumentLink[] {
    const key = this.key(doc.uri); if (!key) return [];
    const links = (this.rendered.get(key)?.images ?? []).map(span => {
      const link = new vscode.DocumentLink(this.range(span), this.command(doc.uri, span));
      link.tooltip = '打开 QQ 图片'; return link;
    });
    for (const span of this.rendered.get(key)?.files ?? []) {
      const target = vscode.Uri.parse(`command:qq.downloadFile?${encodeURIComponent(JSON.stringify([doc.uri.toString(), span.messageId, span.fileIndex]))}`);
      const link = new vscode.DocumentLink(new vscode.Range(span.line, span.start, span.line, span.end), target);
      link.tooltip = '下载文件 / 另存为'; links.push(link);
    }
    for (const action of this.rendered.get(key)?.actions ?? []) {
      const target = action.kind === 'reply' ? this.replyCommand(doc.uri, action.messageId) : action.kind === 'cancel' ? vscode.Uri.parse(`command:qq.cancelMessage?${encodeURIComponent(JSON.stringify([doc.uri.toString(), action.messageId]))}`) : this.retryCommand(doc.uri, action.messageId);
      const link = new vscode.DocumentLink(new vscode.Range(action.line, action.start, action.line, action.start + 4), target);
      link.tooltip = action.kind === 'reply' ? '回复这条消息' : action.kind === 'cancel' ? '取消尚未提交的消息' : '重新发送这条消息'; links.push(link);
    }
    return links;
  }
  private replyCommand(uri: vscode.Uri, messageId: string): vscode.Uri {
    return vscode.Uri.parse(`command:qq.reply?${encodeURIComponent(JSON.stringify([uri.toString(), messageId]))}`);
  }
  private retryCommand(uri: vscode.Uri, messageId: string): vscode.Uri {
    return vscode.Uri.parse(`command:qq.retryMessage?${encodeURIComponent(JSON.stringify([uri.toString(), messageId]))}`);
  }
  async image(uri: vscode.Uri, messageId: string, imageIndex: number): Promise<string> {
    const key = this.key(uri);
    if (!key || !Number.isInteger(imageIndex) || imageIndex < 0) throw new Error('图片不属于当前会话');
    const msg = this.store.messages.get(key)?.find(m => m.id === messageId);
    const local = msg?.localImages?.[imageIndex];
    if (local?.file && this.attachments) {
      try { await this.attachments.read(local); return local.file; } catch { /* Fall back to server media. */ }
    }
    const segment = msg?.segments.filter(s => s.type === 'image')[imageIndex];
    if (!segment || segment.type !== 'image') throw new Error('图片消息已不在当前记录中');
    return this.media.get(segment.image);
  }
  async provideHover(doc: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
    const key = this.key(doc.uri); if (!key) return;
    const file = this.rendered.get(key)?.files.find(f => f.line === pos.line && pos.character >= f.start && pos.character <= f.end);
    if (file) {
      const message = this.store.messages.get(key)?.find(m => m.id === file.messageId);
      const ref = message?.segments.filter(s => s.type === 'text' && s.file)[file.fileIndex];
      const md = new vscode.MarkdownString();
      if (ref?.type === 'text' && ref.file) md.appendText(`${ref.file.name}${ref.file.size ? ` · ${ref.file.size.toLocaleString()} 字节` : ''}`);
      md.appendMarkdown(`\n\n[下载 / 另存为](command:qq.downloadFile?${encodeURIComponent(JSON.stringify([doc.uri.toString(), file.messageId, file.fileIndex]))})`);
      md.isTrusted = { enabledCommands: ['qq.downloadFile'] }; return new vscode.Hover(md);
    }
    const span = this.rendered.get(key)?.images.find(s => this.range(s).contains(pos));
    if (!span) {
      const message = this.messageAt(doc.uri, pos.line);
      if (message?.outgoing && ['failed', 'uncertain'].includes(message.sendState ?? '')) {
        const md = new vscode.MarkdownString(); md.appendText(message.sendError || '发送失败');
        md.appendMarkdown(`\n\n[重试这条消息](${this.retryCommand(doc.uri, message.id).toString()})`);
        md.isTrusted = { enabledCommands: ['qq.retryMessage'] }; return new vscode.Hover(md);
      }
      if (!message || !/^-?\d+$/.test(message.id) || message.id === '0') return;
      const md = new vscode.MarkdownString(`[↩ 回复这条消息](${this.replyCommand(doc.uri, message.id).toString()})`);
      md.isTrusted = { enabledCommands: ['qq.reply'] };
      return new vscode.Hover(md);
    }
    const md = new vscode.MarkdownString();
    md.isTrusted = { enabledCommands: ['qq.openImage', 'qq.insertMessageImage'] };
    try {
      const file = await this.image(doc.uri, span.messageId, span.imageIndex);
      if (token.isCancellationRequested) return;
      md.supportHtml = true;
      md.appendMarkdown(imagePreviewMarkup(file, await fs.readFile(file), doc) + '\n\n');
    } catch (error: any) { md.appendText(error.message); md.appendMarkdown('\n\n'); }
    const insert = vscode.Uri.parse(`command:qq.insertMessageImage?${encodeURIComponent(JSON.stringify(this.imageArgs(doc.uri, span)))}`);
    md.appendMarkdown(`[打开大图](${this.command(doc.uri, span).toString()}) · [引用到发送栏](${insert.toString()})`);
    return new vscode.Hover(md, this.range(span));
  }
  imageRanges(uri: vscode.Uri): vscode.Range[] {
    const key = this.key(uri); return (key ? this.rendered.get(key)?.images ?? [] : []).map(s => this.range(s));
  }
  dispose(): void { clearTimeout(this.timer); this.emitter.dispose(); this.rendered.clear(); }
}
