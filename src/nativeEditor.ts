import * as vscode from 'vscode';
import * as path from 'node:path';
import { attachmentPattern, Attachment, codeString, inline, messageText } from './model';
import { ChatStore } from './store';
import { Transcript } from './transcript';
import { AttachmentFiles } from './attachments';
import { imagePreviewMarkup } from './imageHover';

export const DRAFT_DIVIDER = '// ─── 草稿 · Enter 发送 · Shift/Ctrl+Enter 换行 ───';
interface Host {
  store?: ChatStore; transcript?: Transcript; attachments?: AttachmentFiles;
  beforeHistoryChange(uri: vscode.Uri): void;
  afterHistoryChange(doc: vscode.TextDocument, applied: boolean): void;
}

// VS Code has no public per-range read-only API. Only the explicit draft region is sent.
// This filesystem is local draft storage; saving a document NEVER sends a QQ message.
export class NativeEditor implements vscode.FileSystemProvider, vscode.Disposable {
  private events = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.events.event;
  private buffers = new Map<string, Uint8Array>();
  private prefixes = new Map<string, string>();
  private pending = new Map<string, boolean>();
  private timer?: NodeJS.Timeout;
  private saveTimers = new Map<string, NodeJS.Timeout>();
  private updating = new Map<string, Promise<void>>();
  private expectedEdits = new Map<string, string>();
  private repairs = new Set<string>();
  constructor(private host: Host) {}
  watch(): vscode.Disposable { return new vscode.Disposable(() => {}); }
  stat(uri: vscode.Uri): vscode.FileStat { return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: this.readFile(uri).length }; }
  readDirectory(): [string, vscode.FileType][] { return []; }
  createDirectory(): void { throw vscode.FileSystemError.NoPermissions(); }
  delete(): void { throw vscode.FileSystemError.NoPermissions(); }
  rename(): void { throw vscode.FileSystemError.NoPermissions(); }
  readFile(uri: vscode.Uri): Uint8Array {
    const key = this.host.transcript?.key(uri), store = this.host.store;
    if (!key || !store) throw vscode.FileSystemError.Unavailable('请连接对应 QQ 账号后重新打开会话');
    const cached = this.buffers.get(uri.toString()); if (cached) return cached;
    const prefix = this.prefix(uri, key);
    const bytes = Buffer.from(prefix + store.draft(key).text, 'utf8');
    this.buffers.set(uri.toString(), bytes); return bytes;
  }
  writeFile(uri: vscode.Uri, content: Uint8Array): void {
    if (!this.host.transcript?.key(uri)) throw vscode.FileSystemError.NoPermissions('账号已切换');
    this.buffers.set(uri.toString(), content);
  }
  private prefix(uri: vscode.Uri, key: string): string {
    const history = this.host.transcript!.provideTextDocumentContent(uri);
    const reply = this.host.store!.draft(key).replyId;
    const target = reply && this.host.store!.displayMessages(key).find(m => m.id === reply);
    const preview = target ? `${inline(target.senderName)}：${inline(messageText(target)).slice(0, 100)}` : `消息 ${reply}`;
    const prefix = `${history}\n${reply ? `// ↪ 正在回复 ${preview}\nreply_to("${codeString(reply)}");\n` : ''}\n${DRAFT_DIVIDER}\n`;
    this.prefixes.set(uri.toString(), prefix); return prefix;
  }
  region(doc: vscode.TextDocument): { boundary: number; start: number; text: string } | undefined {
    const text = doc.getText(), divider = `\n${DRAFT_DIVIDER}\n`;
    const prefix = this.prefixes.get(doc.uri.toString());
    if (prefix && text.startsWith(prefix)) return { boundary: prefix.length - divider.length, start: prefix.length, text: text.slice(prefix.length) };
    const boundary = text.indexOf(divider);
    if (boundary < 0 || text.indexOf(divider, boundary + divider.length) >= 0) return;
    const start = boundary + divider.length;
    return { boundary, start, text: text.slice(start) };
  }
  inDraft(editor: vscode.TextEditor): boolean {
    if (!this.host.transcript?.key(editor.document.uri)) return false;
    const region = this.region(editor.document);
    return !!region && editor.selections.every(s => editor.document.offsetAt(s.start) >= region.start);
  }
  historyMatches(doc: vscode.TextDocument): boolean {
    const region = this.region(doc);
    return !!region && doc.getText().slice(0, region.start) === this.prefixes.get(doc.uri.toString());
  }
  changed(doc: vscode.TextDocument, changes: readonly vscode.TextDocumentContentChangeEvent[] = []): void {
    const key = this.host.transcript?.key(doc.uri), store = this.host.store;
    if (!key || !store) return;
    const uri = doc.uri.toString(), text = doc.getText();
    const internal = this.expectedEdits.get(uri) === text;
    if (internal) this.expectedEdits.delete(uri);
    if (!internal && changes.length && !this.historyMatches(doc)) {
      const old = Buffer.from(this.buffers.get(uri) ?? []).toString('utf8');
      const divider = `\n${DRAFT_DIVIDER}\n`, boundary = old.indexOf(divider);
      const start = boundary < 0 ? -1 : boundary + divider.length;
      let draft = start >= 0 ? old.slice(start) : store.draft(key).text;
      if (start >= 0) for (const change of [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset)) {
        const end = change.rangeOffset + change.rangeLength;
        if (end < start || (end === start && change.rangeOffset < start)) continue;
        const from = Math.max(0, change.rangeOffset - start), to = Math.max(0, end - start);
        draft = draft.slice(0, from) + change.text + draft.slice(to);
      }
      if (draft !== store.draft(key).text) store.setDraft(key, draft, store.draft(key).replyId);
      this.repairs.add(uri);
      const editor = vscode.window.visibleTextEditors.find(e => e.document === doc);
      if (editor) void this.sync(editor, true, true).then(() => {
        if (changes.some(c => c.rangeOffset + c.rangeLength >= start) && vscode.window.activeTextEditor === editor) return this.focus(editor);
      }).catch(() => {});
      return;
    }
    this.buffers.set(doc.uri.toString(), Buffer.from(doc.getText(), 'utf8'));
    const region = this.region(doc);
    if (region && region.text !== store.draft(key).text) store.setDraft(key, region.text, store.draft(key).replyId);
    clearTimeout(this.saveTimers.get(uri));
    this.saveTimers.set(uri, setTimeout(() => {
      this.saveTimers.delete(uri); if (!doc.isClosed && doc.isDirty) void doc.save();
    }, 500));
    this.updateContext();
  }
  updateContext(): void {
    const editor = vscode.window.activeTextEditor;
    void vscode.commands.executeCommand('setContext', 'qq.inDraft', !!editor && this.inDraft(editor));
  }
  schedule(key: string, history = false): void {
    this.pending.set(key, history || !!this.pending.get(key));
    if (!this.timer) this.timer = setTimeout(() => {
      this.timer = undefined;
      const pending = [...this.pending]; this.pending.clear();
      for (const [key, history] of pending) {
        const editor = vscode.window.visibleTextEditors.find(e => this.host.transcript?.key(e.document.uri) === key);
        if (editor) void this.sync(editor, history).catch(() => {});
      }
    }, 40);
  }
  async sync(editor: vscode.TextEditor, history = true, restore = false): Promise<void> {
    const uri = editor.document.uri.toString();
    const previous = this.updating.get(uri) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      const doc = editor.document, key = this.host.transcript?.key(doc.uri), store = this.host.store;
      if (!key || !store || doc.isClosed) return;
      restore ||= this.repairs.has(uri);
      const region = this.region(doc);
      if (!region && !restore) return;
      if (history || restore) this.host.beforeHistoryChange(doc.uri);
      const prefix = history || restore ? this.prefix(doc.uri, key) : doc.getText().slice(0, region!.start);
      const draft = store.draft(key).text;
      if (doc.getText() === prefix + draft) { this.repairs.delete(uri); if (history || restore) this.host.afterHistoryChange(doc, false); return; }
      this.expectedEdits.set(uri, prefix + draft);
      const applied = await editor.edit(edit => {
        if (restore) edit.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), prefix + draft);
        else {
          if (region!.text !== draft) edit.replace(new vscode.Range(doc.positionAt(region!.start), doc.positionAt(doc.getText().length)), draft);
          const oldPrefix = doc.getText().slice(0, region!.start);
          if (oldPrefix !== prefix) {
            // Keep unchanged history in the editor model so its scroll anchor survives.
            let start = 0, oldEnd = oldPrefix.length, newEnd = prefix.length;
            while (start < oldEnd && start < newEnd && oldPrefix[start] === prefix[start]) start++;
            while (oldEnd > start && newEnd > start && oldPrefix[oldEnd - 1] === prefix[newEnd - 1]) { oldEnd--; newEnd--; }
            edit.replace(new vscode.Range(doc.positionAt(start), doc.positionAt(oldEnd)), prefix.slice(start, newEnd));
          }
        }
      }, { undoStopBefore: false, undoStopAfter: false });
      if (history || restore) this.host.afterHistoryChange(doc, applied);
      if (applied) this.repairs.delete(uri);
      else this.expectedEdits.delete(uri);
      if (!applied) this.schedule(key, history);
    });
    this.updating.set(uri, task);
    try { await task; } finally { if (this.updating.get(uri) === task) this.updating.delete(uri); }
  }
  isUpdating(doc: vscode.TextDocument): boolean { return this.updating.has(doc.uri.toString()); }
  async focus(editor: vscode.TextEditor): Promise<void> {
    const region = this.region(editor.document);
    if (!region) throw new Error('草稿分隔线被修改，请使用“QQ: 重建聊天文档”（恢复已缓存草稿）');
    const end = editor.document.positionAt(editor.document.getText().length);
    editor.selection = new vscode.Selection(end, end);
    editor.revealRange(new vscode.Range(end, end)); this.updateContext();
  }
  draft(doc: vscode.TextDocument): string {
    const region = this.region(doc);
    if (!region) throw new Error('草稿分隔线被修改，发送已暂停。请使用“QQ: 重建聊天文档”恢复');
    return region.text;
  }
  async insert(key: string, attachments: Attachment[]): Promise<void> {
    const store = this.host.store; if (!store) return;
    const editor = vscode.window.visibleTextEditors.find(e => this.host.transcript?.key(e.document.uri) === key);
    if (!editor) { store.attach(key, attachments); return; }
    await this.sync(editor, false);
    if (store !== this.host.store || this.host.transcript?.key(editor.document.uri) !== key) return;
    const region = this.region(editor.document);
    if (!region) throw new Error('请先重建聊天文档，再导入图片或表情');
    const prepared = store.prepareAttachments(key, attachments);
    const selection = this.inDraft(editor) ? editor.selection : new vscode.Selection(editor.document.positionAt(editor.document.getText().length), editor.document.positionAt(editor.document.getText().length));
    const applied = await editor.edit(edit => edit.replace(selection, prepared.map(a => a.placeholder).join('')));
    if (!applied) throw new Error('文档在导入时发生变化，请重试');
    await vscode.window.showTextDocument(editor.document, editor.viewColumn); this.updateContext();
  }
  private attachmentAt(doc: vscode.TextDocument, pos: vscode.Position): { attachment: Attachment; range: vscode.Range } | undefined {
    const key = this.host.transcript?.key(doc.uri), region = this.region(doc);
    if (!key || !region || doc.offsetAt(pos) < region.start) return;
    for (const match of region.text.matchAll(attachmentPattern)) {
      const start = region.start + match.index!;
      const range = new vscode.Range(doc.positionAt(start), doc.positionAt(start + match[0].length));
      const attachment = this.host.store?.draft(key).attachments.find(a => a.placeholder === match[0]);
      if (range.contains(pos) && attachment) return { attachment, range };
    }
  }
  async hover(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Hover | undefined> {
    const item = this.attachmentAt(doc, pos); if (!item) return;
    const md = new vscode.MarkdownString(); md.appendText(item.attachment.label);
    if (item.attachment.kind === 'image' && this.host.attachments && item.attachment.file) {
      const bytes = await this.host.attachments.read(item.attachment);
      md.supportHtml = true;
      md.appendMarkdown(`\n\n${imagePreviewMarkup(item.attachment.file, bytes, doc)}`);
    }
    if (item.attachment.kind === 'file') md.appendText(`\n大小：${(item.attachment.size ?? 0).toLocaleString()} 字节\nEnter 发送；删除占位符可取消附件`);
    return new vscode.Hover(md, item.range);
  }
  links(doc: vscode.TextDocument): vscode.DocumentLink[] {
    const region = this.region(doc); if (!region) return [];
    const result: vscode.DocumentLink[] = [];
    for (const match of region.text.matchAll(/\[图片:\d+\]/g)) {
      const item = this.attachmentAt(doc, doc.positionAt(region.start + match.index!));
      if (item?.attachment.file) {
        const link = new vscode.DocumentLink(item.range, vscode.Uri.parse(`command:qq.openDraftImage?${encodeURIComponent(JSON.stringify([doc.uri.toString(), item.attachment.id]))}`));
        link.tooltip = '预览待发送图片'; result.push(link);
      }
    }
    return result;
  }
  async drop(doc: vscode.TextDocument, position: vscode.Position, data: vscode.DataTransfer, token: vscode.CancellationToken): Promise<vscode.DocumentDropEdit | undefined> {
    const key = this.host.transcript?.key(doc.uri), region = this.region(doc), store = this.host.store, files = this.host.attachments;
    if (!key || !region || !store || !files || doc.offsetAt(position) < region.start) return;
    const version = doc.version;
    const attachments: Attachment[] = [], seen = new Set<string>();
    const normalize = (value: string | vscode.Uri): vscode.Uri => {
      if (typeof value === 'string' && /^[a-z]:[\\/]/i.test(value)) return vscode.Uri.file(value);
      const uri = typeof value === 'string' ? vscode.Uri.parse(value) : value;
      // Electron can expose a Windows OS file path as a drive-letter URI.
      return /^[a-z]$/i.test(uri.scheme) && /^[\\/]/.test(uri.path) ? vscode.Uri.file(uri.scheme + ':' + uri.path) : uri;
    };
    const uris = data.get('text/uri-list');
    const resources: vscode.Uri[] = uris ? (await uris.asString()).split(/\r?\n/).filter(s => s && !s.startsWith('#')).map(s => normalize(s)) : [];
    const external = [...data].map(([, item]) => item.asFile()).filter((f): f is vscode.DataTransferFile => !!f);
    for (const file of external) if (file.uri) resources.push(normalize(file.uri));
    if (resources.length + external.filter(f => !f.uri).length > 8) {
      // The same file may be offered as both a URI and an OS file entry.
      if (new Set(resources.map(u => u.toString())).size + external.filter(f => !f.uri).length > 8) throw new Error('每条消息最多附带 8 个附件');
    }
    for (const uri of resources) {
      const identity = process.platform === 'win32' ? uri.toString().toLowerCase() : uri.toString();
      if (seen.has(identity)) continue;
      seen.add(identity);
      if (token.isCancellationRequested) return;
      if (uri.scheme !== 'file') throw new Error('请从本机文件管理器拖入文件');
      attachments.push(await files.stageFilePath(uri.fsPath, path.basename(uri.fsPath)));
    }
    for (const file of external.filter(f => !f.uri)) {
      if (token.isCancellationRequested) return;
      attachments.push(await files.stageFile(Buffer.from(await file.data()), file.name));
    }
    if (!attachments.length || token.isCancellationRequested || store !== this.host.store || doc.version !== version || doc.isClosed) return;
    const prepared = store.prepareAttachments(key, attachments);
    return new vscode.DocumentDropEdit(prepared.map(a => a.placeholder).join(''), '作为 QQ 文件附件插入', vscode.DocumentDropOrPasteEditKind.Empty.append('qq', 'file'));
  }
  async paste(doc: vscode.TextDocument, ranges: readonly vscode.Range[], data: vscode.DataTransfer, token: vscode.CancellationToken): Promise<vscode.DocumentPasteEdit[] | undefined> {
    const key = this.host.transcript?.key(doc.uri), region = this.region(doc), store = this.host.store, files = this.host.attachments;
    if (!key || !region || !store || !files || ranges.some(r => doc.offsetAt(r.start) < region.start)) return;
    const images = [...data].filter(([mime, item]) => mime.startsWith('image/') && item.asFile());
    if (!images.length) return;
    if (ranges.length !== 1) throw new Error('粘贴图片时请只保留一个光标');
    const attachments: Attachment[] = [];
    // Clipboard formats often contain alternative representations of the same image.
    const file = (images.find(([mime]) => mime === 'image/png') ?? images[0])[1].asFile()!;
    attachments.push(await files.stage(Buffer.from(await file.data()), file.name || '粘贴的图片'));
    if (token.isCancellationRequested || store !== this.host.store) return;
    const prepared = store.prepareAttachments(key, attachments);
    return [new vscode.DocumentPasteEdit(prepared.map(a => a.placeholder).join(''), '作为 QQ 图片占位符粘贴', vscode.DocumentDropOrPasteEditKind.Empty.append('qq', 'image'))];
  }
  dispose(): void {
    clearTimeout(this.timer); for (const timer of this.saveTimers.values()) clearTimeout(timer);
    this.events.dispose(); this.buffers.clear();
  }
}
