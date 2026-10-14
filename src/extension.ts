import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { OneBotClient } from './onebot';
import { ChatStore } from './store';
import { MediaCache } from './media';
import { Transcript } from './transcript';
import { ChatTree, Section } from './tree';
import { Composer } from './composer';
import { Configuration } from './configuration';
import { ConnectionSettings } from './settings';
import { AttachmentFiles } from './attachments';
import { downloadFile } from './download';
import { uploadToNapCat } from './fileUpload';
import { NotificationSync, allowsUnread } from './notifications';
import { NativeEditor } from './nativeEditor';
import { Attachment, Chat, Message, draftParts, outgoingDrafts, id, messageText, newChat, parseMessage, splitKey } from './model';

type Anchor = { messageId?: string; offset: number; character: number; draftOffset?: number };
type ViewSnapshot = { editor: vscode.TextEditor; follow: boolean; top: Anchor; selections: { anchor: Anchor; active: Anchor }[] };
export class QQApp implements vscode.Disposable {
  readonly client = new OneBotClient();
  readonly config: Configuration;
  readonly settings: ConnectionSettings;
  readonly composer: Composer;
  readonly native: NativeEditor;
  readonly trees: ChatTree[] = [];
  private treeViews = new Map<Section, vscode.TreeView<Chat>>();
  notifications?: NotificationSync;
  private notificationTimer?: NodeJS.Timeout;
  private filterInput?: vscode.InputBox;
  store?: ChatStore;
  transcript?: Transcript;
  attachments?: AttachmentFiles;
  target?: string;
  ready = false;
  private disposables: vscode.Disposable[] = [];
  private output = vscode.window.createOutputChannel('QQ');
  private status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  private imageDecoration = vscode.window.createTextEditorDecorationType({ color: new vscode.ThemeColor('textLink.foreground'), textDecoration: 'underline' });
  private ownDecoration = vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'), borderWidth: '0 0 0 2px', borderStyle: 'solid', borderColor: new vscode.ThemeColor('editorGutter.addedBackground') });
  private mentionDecoration!: vscode.TextEditorDecorationType;
  private replyDecoration!: vscode.TextEditorDecorationType;
  private initializationRetry?: NodeJS.Timeout;
  private cacheTimer?: NodeJS.Timeout;
  private cleaningCache?: Promise<number>;
  private replyLookups = new Map<string, Promise<boolean>>();
  private cancelled = new Set<string>();
  private memberLoaded = new Map<string, number>();
  private following = new Map<vscode.TextEditor, boolean>();
  private pendingMessages = new Map<string, number>();
  private newMessagesStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 9);
  private scrollGuards = new Map<string, NodeJS.Timeout>();
  private snapshots = new Map<string, ViewSnapshot[]>();
  private historyVersions = new Map<string, number>();
  private historyCounts = new Map<string, number>();
  private submitting = new Set<string>();
  private sendQueues = new Map<string, Promise<boolean>>();
  private tabChanges = new vscode.EventEmitter<vscode.Uri | undefined>();
  private queued: any[] = [];
  private epoch = 0;
  private openVersion = 0;
  private initialization: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(readonly context: vscode.ExtensionContext) {
    this.config = new Configuration(context);
    this.refreshHighlights();
    this.disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('qq')) {
        this.refreshHighlights();
        if (this.store) this.store.limit = this.config.messageLimit;
        for (const editor of vscode.window.visibleTextEditors) this.decorate(editor);
      }
    }));
    this.settings = new ConnectionSettings(context, this.config, () => this.connect(), () => this.cacheInfo(), () => this.cleanCache(true));
    this.disposables.push(this.settings);
    this.composer = new Composer(context, this);
    this.native = new NativeEditor(this);
    this.status.command = 'qq.connect'; this.status.name = 'QQ 连接'; this.status.show();
    this.newMessagesStatus.command = 'qq.latest'; this.newMessagesStatus.name = 'QQ 新消息';
    this.disposables.push(this.tabChanges, vscode.window.registerFileDecorationProvider({
      onDidChangeFileDecorations: this.tabChanges.event,
      provideFileDecoration: uri => this.tabDecoration(uri)
    }));
    this.disposables.push(this.output, this.status, this.imageDecoration, this.ownDecoration, this.newMessagesStatus);
    this.disposables.push(this.native, vscode.workspace.registerFileSystemProvider('qqchat', this.native, { isCaseSensitive: true }));
    const selector = { scheme: 'qqchat', language: 'qq-chat' };
    this.disposables.push(vscode.languages.registerCompletionItemProvider(selector, {
      provideCompletionItems: (doc, position) => {
        const region = this.native.region(doc);
        if (!region || doc.offsetAt(position) < region.start) return [];
        const before = doc.lineAt(position.line).text.slice(0, position.character);
        const match = /(?:^|\s)(\/[\w\u4e00-\u9fff]*)$/.exec(before);
        if (!match) {
          const at = /(?:^|\s)@([^\s@]*)$/.exec(before);
          const key = this.transcript?.key(doc.uri);
          if (!at || !key?.startsWith('group:')) return [];
          const range = new vscode.Range(position.translate(0, -at[0].trimStart().length), position);
          return [...this.store?.members.get(key)?.values() ?? []].filter(m => `${m.name} ${m.nickname} ${m.id}`.toLowerCase().includes(at[1].toLowerCase())).map(m => {
            const item = new vscode.CompletionItem(m.name, vscode.CompletionItemKind.User);
            item.filterText = `@${m.name} ${m.nickname ?? ''} ${m.id}`; item.detail = `${m.nickname ?? ''} · ${m.id}`; item.range = range; item.insertText = `@[${m.id}] `; return item;
          });
        }
        const range = new vscode.Range(position.translate(0, -match[1].length), position);
        return ['/表情', '/emoji', '/图片', '/文件'].map((label, i) => {
          const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Function);
          item.detail = '打开底部表情选择器 · 方向键选择 · Enter 插入 · Esc 返回';
          item.range = range; item.insertText = ''; item.sortText = String(i);
          item.command = { command: label === '/图片' ? 'qq.insertImage' : label === '/文件' ? 'qq.insertFile' : 'qq.emojis', title: label };
          if (i > 1) item.detail = '选择附件，在草稿光标处插入占位符';
          return item;
        });
      }
    }, '/', '@'));
    this.disposables.push(vscode.languages.registerDocumentLinkProvider(selector, {
      provideDocumentLinks: doc => [...(this.native.historyMatches(doc) ? this.transcript?.provideDocumentLinks(doc) ?? [] : []), ...this.native.links(doc)]
    }), vscode.languages.registerHoverProvider(selector, {
      provideHover: async (doc, pos, token) => await this.native.hover(doc, pos) ?? (this.native.historyMatches(doc) ? this.transcript?.provideHover(doc, pos, token) : undefined)
    }), vscode.window.registerWebviewViewProvider('qq.composer', this.composer),
    vscode.languages.registerDocumentPasteEditProvider(selector, {
      provideDocumentPasteEdits: (doc, ranges, data, _context, token) => this.native.paste(doc, ranges, data, token)
    }, { pasteMimeTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'], providedPasteEditKinds: [vscode.DocumentDropOrPasteEditKind.Empty.append('qq', 'image')] }));
    this.disposables.push(vscode.languages.registerDocumentDropEditProvider(selector, {
      provideDocumentDropEdits: async (doc, position, data, token) => {
        try { return await this.native.drop(doc, position, data, token); }
        catch (error: any) { void vscode.window.showErrorMessage(`QQ 文件导入失败：${error.message}`); return new vscode.DocumentDropEdit('', '文件未导入', vscode.DocumentDropOrPasteEditKind.Empty.append('qq', 'file')); }
      }
    }, { dropMimeTypes: ['text/uri-list', 'files'], providedDropEditKinds: [vscode.DocumentDropOrPasteEditKind.Empty.append('qq', 'file')] }));
    for (const section of ['list', 'favorites'] as Section[]) {
      const provider = new ChatTree(section, () => this.store); this.trees.push(provider);
      const view = vscode.window.createTreeView(`qq.${section}`, { treeDataProvider: provider, showCollapseAll: false });
      this.treeViews.set(section, view);
      this.disposables.push(provider, view);
      this.disposables.push(provider.onDidChangeTreeData(() => {
        view.message = provider.filter ? `搜索：${provider.filter} · ${provider.getChildren().length} 个结果` : undefined;
      }));
    }
    this.commands();
    this.disposables.push(vscode.window.onDidChangeActiveTextEditor(editor => {
      this.native.updateContext();
      const key = editor && this.transcript?.key(editor.document.uri);
      if (key) { this.target = key; this.composer.update(); this.decorate(editor!); this.checkRead(); }
      this.updateNewMessages();
    }), vscode.window.onDidChangeTextEditorVisibleRanges(({ textEditor: editor }) => {
      if (!this.transcript?.key(editor.document.uri) || this.snapshots.has(editor.document.uri.toString()) || this.scrollGuards.has(editor.document.uri.toString())) return;
      const bottom = this.atBottom(editor);
      this.following.set(editor, bottom);
      if (bottom) this.pendingMessages.delete(this.transcript.key(editor.document.uri)!);
      this.checkRead(); this.updateNewMessages();
    }), vscode.window.onDidChangeVisibleTextEditors(editors => {
      for (const editor of this.following.keys()) if (!editors.includes(editor)) this.following.delete(editor);
      for (const editor of editors) this.decorate(editor);
    }), vscode.window.onDidChangeWindowState(() => this.checkRead()),
    vscode.window.onDidChangeTextEditorSelection(event => {
      this.native.updateContext();
      if (event.kind === vscode.TextEditorSelectionChangeKind.Keyboard || event.kind === vscode.TextEditorSelectionChangeKind.Mouse) this.checkRead();
    }),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (!event.contentChanges.length) return;
      this.native.changed(event.document, event.contentChanges); this.documentChanged(event.document);
    }));
    this.client.on('connected', () => {
      const epoch = ++this.epoch;
      clearTimeout(this.initializationRetry); this.ready = false;
      this.initialization = this.initializeWithRetry(epoch);
    });
    this.client.on('disconnected', () => {
      clearTimeout(this.initializationRetry);
      ++this.epoch; this.ready = false; this.queued = [];
      this.notifications?.dispose(); clearInterval(this.notificationTimer); this.updateStatus('未连接');
    });
    this.client.on('event', event => {
      if (!this.ready) { if (this.queued.length < 1000) this.queued.push(event); return; }
      this.onEvent(event);
    });
    this.updateStatus('未连接');
  }
  async start(): Promise<void> {
    const account = this.context.globalState.get<string>('lastAccount');
    if (account && /^\d+$/.test(account)) await this.bindAccount(account);
    if (vscode.workspace.getConfiguration('qq').get('autoConnect', true)) void this.connect().catch(error => this.log(error));
  }
  async connect(): Promise<void> {
    this.updateStatus('连接中');
    await this.client.connect(this.config.url, await this.config.token());
    await this.initialization;
    if (!this.ready) throw new Error('NapCat 初始化未完成，请查看 QQ 输出日志');
  }
  private async initializeWithRetry(epoch: number, attempt = 0): Promise<void> {
    try { this.updateStatus('同步中'); await this.initialize(epoch); }
    catch (error) {
      if (epoch !== this.epoch || this.stopped) return;
      this.ready = false; this.log(error); this.updateStatus('初始化失败 · 等待重试');
      this.initializationRetry = setTimeout(() => {
        if (epoch === this.epoch && this.client.connected && !this.stopped) this.initialization = this.initializeWithRetry(epoch, attempt + 1);
      }, Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)));
    }
  }
  private async initialize(epoch: number): Promise<void> {
    const info = await this.client.call('get_login_info');
    const selfId = id(info?.user_id);
    if (!/^\d+$/.test(selfId)) throw new Error('NapCat 没有返回有效的登录账号');
    if (epoch !== this.epoch || this.stopped) return;
    await this.bindAccount(selfId);
    if (epoch !== this.epoch || this.stopped) return;
    await this.refresh();
    if (epoch !== this.epoch || this.stopped) return;
    const syncSince = new Map([...this.store!.chats.values()].map(c => [c.key, c.lastTime]));
    this.ready = true; this.updateStatus('已连接');
    clearInterval(this.notificationTimer);
    this.notificationTimer = setInterval(() => { if (this.ready) void this.notifications?.refresh(); }, 60000);
    const queued = this.queued; this.queued = [];
    for (const event of queued) this.onEvent(event);
    void this.syncRecentHistory(epoch, syncSince).catch(error => this.log(error));
    void this.cleanCache().catch(error => this.log(error));
    clearInterval(this.cacheTimer); this.cacheTimer = setInterval(() => { void this.cleanCache().catch(error => this.log(error)); }, 3600000);
    this.output.appendLine('NapCat 连接成功，会话列表已加载。');
  }
  private async syncRecentHistory(epoch: number, since: Map<string, number>): Promise<void> {
    const store = this.store; if (!store) return;
    const open = vscode.workspace.textDocuments.map(d => this.transcript?.key(d.uri)).filter((k): k is string => !!k);
    const recent = [...store.chats.values()].filter(c => c.lastTime > 0).sort((a, b) => b.lastTime - a.lastTime).slice(0, 20).map(c => c.key);
    for (const key of new Set([...open, ...recent])) {
      if (epoch !== this.epoch || store !== this.store || !this.ready) return;
      try { await this.loadHistory(key, false, true, since.get(key) ?? 0); } catch (error) { this.log(error); }
    }
  }
  async cacheInfo(): Promise<{ bytes: number; count: number }> { return this.attachments?.cacheInfo() ?? { bytes: 0, count: 0 }; }
  async cleanCache(manual = false): Promise<number> {
    if (this.cleaningCache) return this.cleaningCache;
    const store = this.store, files = this.attachments; if (!store || !files) return 0;
    const task = (async () => {
      const references = await store.attachmentReferences();
      if (store !== this.store) return 0;
      return files.prune(references, manual ? 0 : vscode.workspace.getConfiguration('qq').get('cacheRetentionDays', 7));
    })();
    this.cleaningCache = task;
    try { return await task; } finally { if (this.cleaningCache === task) this.cleaningCache = undefined; }
  }
  private async bindAccount(selfId: string): Promise<void> {
    if (this.store?.selfId === selfId) return;
    if (this.store) { this.notifications?.dispose(); await this.store.dispose(); this.transcript?.dispose(); }
    this.replyLookups.clear();
    this.target = undefined; this.historyVersions.clear(); this.historyCounts.clear(); this.following.clear(); this.memberLoaded.clear(); this.pendingMessages.clear(); this.updateNewMessages();
    const folder = path.join(this.context.globalStorageUri.fsPath, 'accounts', selfId);
    const store = new ChatStore(folder, selfId, this.config.messageLimit);
    store.on('storageError', error => this.log(error));
    await store.restore();
    this.store = store;
    this.attachments = new AttachmentFiles(path.join(folder, 'outgoing'));
    const transcript = new Transcript(store, new MediaCache(path.join(folder, 'images'), this.client), this.attachments);
    this.transcript = transcript;
    transcript.onDidChange(uri => {
      const key = transcript.key(uri); if (key) this.native.schedule(key, true);
    });
    store.on('change', key => { transcript.invalidate(key); this.trees.forEach(tree => tree.refresh()); const chat = store.chats.get(key); if (chat) this.tabChanges.fire(transcript.uri(chat)); });
    store.on('draft', (key, replyChanged) => { this.native.schedule(key, !!replyChanged); this.composer.update(); });
    await this.context.globalState.update('lastAccount', selfId);
    this.trees.forEach(tree => tree.refresh()); this.composer.update();
  }
  async refresh(): Promise<void> {
    if (!this.client.connected || !this.store) throw new Error('请先连接 NapCat');
    const store = this.store;
    const [friends, groups] = await Promise.all([this.client.call('get_friend_list'), this.client.call('get_group_list')]);
    if (store !== this.store) return;
    for (const friend of Array.isArray(friends) ? friends : []) {
      if (/^\d+$/.test(id(friend.user_id))) store.upsert({ ...newChat('private', friend.user_id, friend.remark || friend.nickname), remark: friend.remark, nickname: friend.nickname });
    }
    for (const group of Array.isArray(groups) ? groups : []) {
      if (/^\d+$/.test(id(group.group_id))) store.upsert(newChat('group', group.group_id, group.group_name));
    }
    this.notifications?.dispose();
    for (const chat of store.chats.values()) if (chat.type === 'group') store.setNotification(chat.key, 'unknown');
    this.notifications = new NotificationSync(store, this.client);
    void this.notifications.refresh();
  }
  private onEvent(event: any): void {
    const store = this.store;
    if (!store || !['message', 'message_sent'].includes(event.post_type)) return;
    if (event.self_id && id(event.self_id) !== store.selfId) return;
    try {
      const message = parseMessage(event, undefined, store.selfId);
      if (!store.chats.has(message.chatKey)) {
        const key = splitKey(message.chatKey);
        store.upsert(newChat(key.type, key.id, key.type === 'private' ? message.senderName : key.id));
      }
      if (message.senderId === store.selfId && message.fileIds?.length) {
        const local = store.messages.get(message.chatKey)?.find(m => m.id.startsWith('local:') && m.fileIds?.some(f => message.fileIds!.includes(f)));
        if (local) { store.settleOutgoing(message.chatKey, local.id, { ...local, ...message }); return; }
      }
      const added = store.add(message, true);
      if (added && message.senderId !== store.selfId) void this.notifyMessage(store, message);
      if (added && message.senderId !== store.selfId && vscode.window.visibleTextEditors.some(e => this.transcript?.key(e.document.uri) === message.chatKey && this.following.get(e) === false)) {
        this.pendingMessages.set(message.chatKey, (this.pendingMessages.get(message.chatKey) ?? 0) + 1); this.updateNewMessages();
      }
      void this.notifications?.ensure(message.chatKey);
    } catch { this.output.appendLine('跳过一条无法识别的消息事件。'); }
  }
  tabDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const key = this.transcript?.key(uri), chat = key && this.store?.chats.get(key);
    if (!chat || !chat.unread || !allowsUnread(chat)) return;
    return {
      badge: chat.mentioned ? '@' : chat.replied ? '↩' : chat.unread > 99 ? '99' : String(chat.unread),
      tooltip: `${chat.unread} 条未读${chat.mentioned ? ' · 有人 @我' : ''}${chat.replied ? ' · 有人回复我' : ''}`,
      color: new vscode.ThemeColor(chat.mentioned || chat.replied ? 'list.warningForeground' : 'textLink.foreground')
    };
  }
  private async resolveReply(store: ChatStore, message: Message): Promise<boolean> {
    if (!message.replyId || message.senderId === store.selfId) return false;
    if (message.replyToSelf !== undefined) return message.replyToSelf;
    const target = store.messages.get(message.chatKey)?.find(m => m.id === message.replyId);
    const lookup = `${store.selfId}:${message.chatKey}:${message.replyId}`;
    let result: boolean;
    if (target) result = target.senderId === store.selfId;
    else {
      let task = this.replyLookups.get(lookup);
      if (!task) {
        task = this.client.call('get_msg', { message_id: message.replyId }, 5000).then(raw => {
          const sender = id(raw?.sender?.user_id ?? raw?.user_id); if (!sender) throw new Error('引用消息不可用');
          return sender === store.selfId;
        });
        this.replyLookups.set(lookup, task);
      }
      try { result = await task; } finally { this.replyLookups.delete(lookup); }
    }
    if (store === this.store) {
      const current = store.messages.get(message.chatKey)?.find(m => m.id === message.id);
      if (current) store.enrichMessage({ ...current, replyToSelf: result });
    }
    return result;
  }
  private async notifyMessage(store: ChatStore, message: Message): Promise<void> {
    const key = message.chatKey;
    const replyToSelf = await this.resolveReply(store, message).catch(() => false);
    if (store === this.store && replyToSelf) store.markReplyToSelf(key);
    await this.notifications?.ensure(key);
    const chat = store.chats.get(key);
    if (store !== this.store || !chat?.unread || !allowsUnread(chat)) return;
    if (!message.mentioned && !replyToSelf && this.isReading(key)) return;
    const mode = vscode.workspace.getConfiguration('qq').get<string>('notifications', 'all');
    if (mode === 'off' || (mode === 'mentions' && !message.mentioned && !replyToSelf)) return;
    const reason = message.mentioned ? '有人 @你' : replyToSelf ? '有人回复你' : '新消息';
    const choice = await vscode.window.showInformationMessage(`${chat.name} · ${reason}：${messageText(message).replace(/\s+/g, ' ').slice(0, 100)}`, '查看');
    if (choice === '查看' && store === this.store) await this.openChat(key);
  }
  async openChat(input: string | Chat): Promise<void> {
    const key = typeof input === 'string' ? input : input.key;
    const store = this.store, transcript = this.transcript;
    const chat = store?.chats.get(key);
    if (!chat || !store || !transcript) throw new Error('当前账号没有这个会话');
    const version = ++this.openVersion;
    await store.load(key);
    if (version !== this.openVersion || store !== this.store) return;
    const doc = await vscode.workspace.openTextDocument(transcript.uri(chat));
    await vscode.languages.setTextDocumentLanguage(doc, 'qq-chat');
    if (version !== this.openVersion || store !== this.store) return;
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    await this.native.sync(editor);
    this.target = key; this.following.set(editor, true);
    this.latest(editor); this.decorate(editor); this.composer.update();
    await this.native.focus(editor);
    if (this.client.connected) void this.loadHistory(key).catch(error => this.log(error));
    if (this.client.connected && chat.type === 'group') void this.loadMembers(key);
    this.checkRead();
  }
  async loadHistory(key: string, more = false, reconnect = false, reconnectSince?: number): Promise<void> {
    const store = this.store; if (!store) return;
    if (more) for (const editor of vscode.window.visibleTextEditors) if (this.transcript?.key(editor.document.uri) === key) this.following.set(editor, false);
    const lastTime = reconnectSince ?? store.chats.get(key)?.lastTime ?? 0;
    const epoch = this.epoch;
    const version = (this.historyVersions.get(key) ?? 0) + 1; this.historyVersions.set(key, version);
    const chat = splitKey(key);
    const count = Math.min(store.limit, reconnect ? store.limit : more ? (this.historyCounts.get(key) ?? this.config.historyCount) + this.config.historyCount : this.config.historyCount);
    this.historyCounts.set(key, count);
    const data = await this.client.call(chat.type === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history', { [chat.type === 'group' ? 'group_id' : 'user_id']: chat.id, count });
    if (store !== this.store || epoch !== this.epoch || this.historyVersions.get(key) !== version) return;
    const messages: Message[] = [];
    for (const raw of Array.isArray(data?.messages) ? data.messages : []) { try { messages.push(parseMessage(raw, key, store.selfId)); } catch {} }
    await store.load(key);
    if (store !== this.store || epoch !== this.epoch || this.historyVersions.get(key) !== version) return;
    if (reconnect && lastTime > 0) {
      for (const message of [...messages].sort((a, b) => a.time - b.time)) if (message.time >= lastTime) {
        if (store.add(message, true) && message.senderId !== store.selfId) {
          const reply = await this.resolveReply(store, message).catch(() => false);
          if (store !== this.store || epoch !== this.epoch) return;
          if (reply) store.markReplyToSelf(key);
        }
      }
    }
    store.history(key, messages);
    // Resolve missing originals in bounded batches; do not block editor opening.
    void (async () => {
      for (let i = 0; i < messages.length; i += 4) {
        if (store !== this.store || epoch !== this.epoch) return;
        await Promise.allSettled(messages.slice(i, i + 4).filter(m => m.replyId).map(m => this.resolveReply(store, m)));
      }
    })();
  }
  async loadMembers(key: string): Promise<void> {
    const store = this.store, epoch = this.epoch;
    if (!store || !key.startsWith('group:') || Date.now() - (this.memberLoaded.get(key) ?? 0) < 300000) return;
    this.memberLoaded.set(key, Date.now());
    try {
      const members = await this.client.call('get_group_member_list', { group_id: splitKey(key).id }, 10000);
      if (store === this.store && epoch === this.epoch && Array.isArray(members)) store.setMembers(key, members);
    } catch { this.memberLoaded.delete(key); }
  }
  async sendMessage(key: string, text: string, replyId?: string): Promise<boolean> {
    const store = this.store;
    if (!store || !store.chats.has(key)) throw new Error('发送对象无效');
    const openDoc = vscode.workspace.textDocuments.find(doc => !doc.isClosed && this.transcript?.key(doc.uri) === key);
    if (openDoc && this.native.isImporting(openDoc)) throw new Error('文件仍在导入，请在占位符出现后发送');
    if (openDoc && !this.native.region(openDoc)) throw new Error('草稿分隔线被修改，发送已暂停。请先重建聊天文档');
    if (!text.trim() && !store.draft(key).attachments.some(a => !a.placeholder)) return false;
    if (text.length > 65536) throw new Error('消息过长，请拆分后发送');
    if (!this.ready) throw new Error('NapCat 未连接，草稿已保留');
    const pendingKey = `${store.selfId}:${key}`;
    if (this.submitting.has(pendingKey)) return false;
    if (replyId && (!/^-?\d+$/.test(replyId) || replyId === '0')) throw new Error('这条消息暂时无法引用');
    const draft = store.draft(key);
    const captured = draft.text === text && draft.replyId === replyId ? draft : store.setDraft(key, text, replyId);
    const drafts = outgoingDrafts(captured);
    this.submitting.add(pendingKey);
    const tasks: Promise<boolean>[] = [];
    for (const outgoing of drafts) {
      const parts = draftParts(outgoing.text, outgoing.attachments);
      const local: Message = {
        id: `local:${randomUUID()}`, chatKey: key, senderId: store.selfId, senderName: '我',
        time: Math.floor(Date.now() / 1000), mentioned: false, replyId: outgoing.replyId,
        sendState: this.sendQueues.has(pendingKey) ? 'queued' : 'sending', outgoing,
        localImages: parts.filter((p): p is Attachment => typeof p !== 'string' && p.kind === 'image'),
        segments: parts.map(p => typeof p === 'string' ? { type: 'text' as const, text: p } : p.kind === 'image' ? { type: 'image' as const, image: { file: '' } } : { type: 'text' as const, text: p.kind === 'file' ? p.placeholder ?? `[文件:${p.label}]` : `[表情:${p.faceId}]` })
      };
      store.add(local, false);
      tasks.push(this.queueOutgoing(store, local));
    }
    store.completeSend(key, captured);
    try { await this.syncOutgoing(store, key, true); }
    finally { this.submitting.delete(pendingKey); }
    return (await Promise.all(tasks)).every(Boolean);
  }
  private async syncOutgoing(store: ChatStore, key: string, follow = false): Promise<void> {
    if (store !== this.store) return;
    this.composer.update();
    for (const editor of vscode.window.visibleTextEditors.filter(e => this.transcript?.key(e.document.uri) === key)) {
      if (follow) this.following.set(editor, true);
      await this.native.sync(editor, true);
      if (follow) this.latest(editor);
    }
  }
  private queueOutgoing(store: ChatStore, message: Message): Promise<boolean> {
    const queueKey = `${store.selfId}:${message.chatKey}`;
    const previous = this.sendQueues.get(queueKey) ?? Promise.resolve(true);
    const files = this.attachments, epoch = this.epoch;
    const task = previous.catch(() => false).then(async () => {
      let requested = false;
      const checkCancelled = () => { if (this.cancelled.has(message.id)) throw new Error('已取消发送'); };
      try {
        checkCancelled();
        if (store !== this.store || epoch !== this.epoch || !this.ready) throw new Error('连接已变化，消息尚未提交');
        message.sendState = 'sending'; message.sendError = undefined; message.sendProgress = undefined; store.enrichMessage(message);
        await store.flush();
        const draft = message.outgoing!;
        const parts = draftParts(draft.text, draft.attachments);
        const used = parts.filter((p): p is Attachment => typeof p !== 'string');
        const file = used.find(a => a.kind === 'file');
        if (file && files) {
          const source = await files.filePath(file);
          const check = () => { checkCancelled(); if (store !== this.store || epoch !== this.epoch || !this.ready) throw new Error('连接已变化，上传已暂停'); };
          let lastUpdate = 0;
          const remote = await uploadToNapCat(this.client, source, progress => {
            check(); message.sendProgress = progress;
            if (Date.now() - lastUpdate > 200 || progress.stage === 'confirm') { lastUpdate = Date.now(); store.enrichMessage(message); }
          }, check);
          check();
          const chat = splitKey(message.chatKey);
          requested = true;
          const result = await this.client.call(chat.type === 'group' ? 'upload_group_file' : 'upload_private_file', {
            [chat.type === 'group' ? 'group_id' : 'user_id']: chat.id, file: remote, name: file.label
          }, 30 * 60 * 1000);
          message.sendProgress = undefined;
          message.fileIds = result?.file_id ? [String(result.file_id)] : undefined;
          store.settleOutgoing(message.chatKey, message.id, { ...message, id: id(result?.message_id) || message.id });
          await store.flush();
          await this.syncOutgoing(store, message.chatKey).catch(error => this.log(error));
          return true;
        }
        checkCancelled();
        const media = files ? await files.segments(used) : [];
        if (store !== this.store || epoch !== this.epoch || !this.ready) throw new Error('连接已变化，消息尚未提交');
        checkCancelled();
        const segments: unknown[] = draft.replyId ? [{ type: 'reply', data: { id: draft.replyId } }] : [];
        let index = 0;
        for (const part of parts) {
          if (typeof part !== 'string') { segments.push(media[index++]); continue; }
          let start = 0;
          if (message.chatKey.startsWith('group:')) for (const match of part.matchAll(/@\[(\d+)\]/g)) {
            if (match.index! > start) segments.push({ type: 'text', data: { text: part.slice(start, match.index) } });
            segments.push({ type: 'at', data: { qq: match[1] } }); start = match.index! + match[0].length;
          }
          if (start < part.length) segments.push({ type: 'text', data: { text: part.slice(start) } });
        }
        const chat = splitKey(message.chatKey);
        requested = true;
        const result = await this.client.call('send_msg', { message_type: chat.type, [chat.type === 'group' ? 'group_id' : 'user_id']: chat.id, message: segments });
        const confirmed = store.settleOutgoing(message.chatKey, message.id, { ...message, id: id(result?.message_id) || message.id });
        if (message.localImages?.length && result?.message_id && store === this.store && epoch === this.epoch) {
          void this.client.call('get_msg', { message_id: result.message_id }).then(raw => {
            if (store === this.store && raw?.message && id(raw.message_id) === confirmed.id) store.enrichMessage(parseMessage(raw, message.chatKey, store.selfId));
          }).catch(error => this.log(`图片详情稍后获取：${error.message}`));
        }
        await this.syncOutgoing(store, message.chatKey).catch(error => this.log(error));
        return true;
      } catch (error: any) {
        if (this.cancelled.has(message.id) && !requested) {
          message.sendState = 'cancelled'; message.outgoing = undefined; message.sendProgress = undefined; message.sendError = undefined; message.localImages = undefined;
        } else {
          message.sendState = requested && !String(error.message).includes('请求失败') ? 'uncertain' : 'failed';
          message.sendError = error.message;
        }
        store.enrichMessage(message);
        await this.syncOutgoing(store, message.chatKey).catch(error => this.log(error));
        return false;
      } finally { this.cancelled.delete(message.id); }
    });
    this.sendQueues.set(queueKey, task);
    void task.finally(() => { if (this.sendQueues.get(queueKey) === task) this.sendQueues.delete(queueKey); });
    return task;
  }
  private atBottom(editor: vscode.TextEditor): boolean {
    return editor.visibleRanges.some(range => range.end.line >= editor.document.lineCount - 3);
  }
  private isReading(key: string): boolean {
    if (!vscode.window.state.focused) return false;
    return vscode.window.visibleTextEditors.some(editor => this.transcript?.key(editor.document.uri) === key
      && (editor === vscode.window.activeTextEditor || (this.composer.focused && this.target === key))
      && (this.following.get(editor) ?? this.atBottom(editor)));
  }
  checkRead(): void { if (this.target && this.isReading(this.target)) this.store?.markRead(this.target); }
  private latest(editor = vscode.window.activeTextEditor, markRead = true): void {
    const key = editor && this.transcript?.key(editor.document.uri);
    if (!editor || !key) return;
    this.following.set(editor, true);
    this.pendingMessages.delete(key);
    const last = editor.document.lineAt(editor.document.lineCount - 1).range.end;
    editor.revealRange(new vscode.Range(last, last), vscode.TextEditorRevealType.Default);
    if (markRead) this.checkRead(); this.updateNewMessages();
  }
  private updateNewMessages(): void {
    const editor = vscode.window.activeTextEditor, key = editor && this.transcript?.key(editor.document.uri);
    const count = key ? this.pendingMessages.get(key) ?? 0 : 0;
    if (!key || !editor || this.following.get(editor) !== false) { this.newMessagesStatus.hide(); return; }
    this.newMessagesStatus.text = count ? `$(arrow-down) 新消息 · ${count} 条` : '$(arrow-down) 返回最新';
    this.newMessagesStatus.tooltip = '点击回到底部并恢复自动跟随'; this.newMessagesStatus.show();
  }
  private refreshHighlights(): void {
    const cfg = vscode.workspace.getConfiguration('qq');
    const color = (key: string, fallback: string) => { const value = cfg.get(key, fallback); return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback; };
    this.mentionDecoration?.dispose(); this.replyDecoration?.dispose();
    const make = (value: string) => vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: value + '22', borderColor: value, borderStyle: 'solid', borderWidth: '0 0 0 2px', overviewRulerColor: value, overviewRulerLane: vscode.OverviewRulerLane.Right });
    this.mentionDecoration = make(color('mentionColor', '#E5A030'));
    this.replyDecoration = make(color('replyColor', '#409CFF'));
  }
  private decorate(editor: vscode.TextEditor): void {
    const key = this.transcript?.key(editor.document.uri);
    if (!key || !this.transcript) return;
    const reliable = this.native.historyMatches(editor.document);
    editor.setDecorations(this.mentionDecoration, reliable ? (this.transcript.rendered.get(key)?.mentionLines ?? []).map(line => new vscode.Range(line, 0, line, 0)) : []);
    editor.setDecorations(this.replyDecoration, reliable ? (this.transcript.rendered.get(key)?.replyLines ?? []).map(line => new vscode.Range(line, 0, line, 0)) : []);
    editor.setDecorations(this.ownDecoration, reliable ? (this.transcript.rendered.get(key)?.ownLines ?? []).map(line => new vscode.Range(line, 0, line, 0)) : []);
    editor.setDecorations(this.imageDecoration, [
      ...(this.native.historyMatches(editor.document) ? this.transcript.imageRanges(editor.document.uri) : []),
      ...this.native.links(editor.document).map(link => link.range)
    ]);
  }
  beforeHistoryChange(uri: vscode.Uri): void {
    const key = this.transcript?.key(uri); if (!key) return;
    const rendered = this.transcript?.rendered.get(key);
    const anchor = (doc: vscode.TextDocument, p: vscode.Position): Anchor => {
      const region = this.native.region(doc), offset = doc.offsetAt(p);
      if (region && offset >= region.start) return { offset: 0, character: 0, draftOffset: offset - region.start };
      const messageId = rendered?.messages.get(p.line);
      return { messageId, offset: p.line - (messageId ? rendered?.starts.get(messageId) ?? 0 : 0), character: p.character };
    };
    this.snapshots.set(uri.toString(), vscode.window.visibleTextEditors.filter(editor => editor.document.uri.toString() === uri.toString()).map(editor => ({
      editor, follow: this.following.get(editor) ?? this.atBottom(editor),
      top: anchor(editor.document, editor.visibleRanges[0]?.start ?? new vscode.Position(0, 0)),
      selections: editor.selections.map(s => ({ anchor: anchor(editor.document, s.anchor), active: anchor(editor.document, s.active) }))
    })));
  }
  afterHistoryChange(doc: vscode.TextDocument, applied: boolean): void {
    const uri = doc.uri.toString();
    if (!applied) { this.snapshots.delete(uri); return; }
    const key = this.transcript?.key(doc.uri); if (!key) return;
    const rendered = this.transcript?.rendered.get(key);
    const position = (a: Anchor): vscode.Position => {
      const region = this.native.region(doc);
      if (a.draftOffset !== undefined && region) return doc.positionAt(region.start + Math.min(a.draftOffset, region.text.length));
      const line = Math.max(0, Math.min(doc.lineCount - 1, (a.messageId ? rendered?.starts.get(a.messageId) ?? 0 : 0) + a.offset));
      return new vscode.Position(line, Math.min(a.character, doc.lineAt(line).text.length));
    };
    for (const snapshot of this.snapshots.get(doc.uri.toString()) ?? []) {
      const editor = snapshot.editor;
      if (!vscode.window.visibleTextEditors.includes(editor)) continue;
      editor.selections = snapshot.selections.map(s => new vscode.Selection(position(s.anchor), position(s.active)));
      if (snapshot.follow) this.latest(editor, false);
      else {
        const top = position(snapshot.top);
        if (editor.visibleRanges[0]?.start.line !== top.line) editor.revealRange(new vscode.Range(top, top), vscode.TextEditorRevealType.AtTop);
      }
      this.following.set(editor, snapshot.follow);
    }
    this.snapshots.delete(doc.uri.toString());
    clearTimeout(this.scrollGuards.get(uri));
    this.scrollGuards.set(uri, setTimeout(() => { this.scrollGuards.delete(uri); }, 80));
    this.updateNewMessages();
    this.documentChanged(doc);
  }
  private documentChanged(doc: vscode.TextDocument): void {
    for (const editor of vscode.window.visibleTextEditors) if (editor.document === doc) this.decorate(editor);
  }
  private commands(): void {
    const register = (command: string, action: (...args: any[]) => unknown) => {
      this.disposables.push(vscode.commands.registerCommand(command, async (...args: any[]) => {
        try { return await action(...args); } catch (error: any) { this.log(error); void vscode.window.showErrorMessage(error.message); throw error; }
      }));
    };
    const currentKey = (item?: Chat | string): string | undefined => typeof item === 'string' ? item : item?.key ?? this.target;
    register('qq.connect', () => this.connect());
    register('qq.disconnect', () => this.client.disconnect());
    register('qq.configure', () => this.settings.open());
    for (const page of ['list', 'favorites'] as Section[]) register(`qq.show.${page}`, async () => {
      await vscode.commands.executeCommand(`qq.${page}.focus`);
    });
    register('qq.importConfig', async () => { if (await this.config.import()) await this.connect(); });
    register('qq.refresh', () => this.ready ? this.refresh() : this.connect());
    register('qq.openChat', (item: string | Chat) => this.openChat(item));
    register('qq.toggleFavorite', (item?: Chat | string) => { const key = currentKey(item); if (key) this.store?.toggleFavorite(key); });
    register('qq.markRead', (item?: Chat | string) => { const key = currentKey(item); if (key) this.store?.markRead(key); });
    register('qq.toggleIgnoreUnread', (item?: Chat | string) => { const key = currentKey(item); if (key) this.store?.toggleIgnoreUnread(key); });
    for (const tree of this.trees) {
      register(`qq.search.${tree.section}`, () => this.searchList(tree.section));
      register(`qq.clearSearch.${tree.section}`, () => this.filterList(tree.section, ''));
    }
    register('qq.focusInput', () => this.focusInput());
    register('qq.send', async () => {
      const editor = vscode.window.activeTextEditor, key = editor && this.transcript?.key(editor.document.uri);
      if (editor && key) await this.sendMessage(key, this.native.draft(editor.document), this.store?.draft(key).replyId);
    });
    register('qq.newline', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !this.native.inDraft(editor)) return;
      await editor.edit(edit => { for (const selection of editor.selections) edit.replace(selection, '\n'); });
    });
    register('qq.retryMessage', async (uri: string, messageId: string) => {
      if (typeof uri !== 'string' || typeof messageId !== 'string') return;
      const store = this.store, key = this.transcript?.key(vscode.Uri.parse(uri));
      const message = key && store?.messages.get(key)?.find(m => m.id === messageId);
      if (!store || !message || !message.outgoing || !['failed', 'uncertain'].includes(message.sendState ?? '')) return;
      if (!this.ready) throw new Error('NapCat 未连接，消息仍保留在记录中');
      const state = message.sendState;
      if (state === 'uncertain' && await vscode.window.showWarningMessage('这条消息的结果未确认，可能已经送达。检查聊天记录后仍要重试吗？', { modal: true }, '仍然重试') !== '仍然重试') return;
      if (store !== this.store || message.sendState !== state) return;
      message.sendState = 'queued'; message.sendError = undefined; store.enrichMessage(message);
      return this.queueOutgoing(store, message);
    });
    register('qq.cancelMessage', async (uri: string, messageId: string) => {
      const key = this.transcript?.key(vscode.Uri.parse(uri));
      const message = key && this.store?.messages.get(key)?.find(m => m.id === messageId);
      if (!message || !(message.sendState === 'queued' || (message.sendState === 'sending' && message.sendProgress?.stage === 'upload'))) return;
      this.cancelled.add(message.id); message.sendState = 'cancelled'; message.sendProgress = undefined;
      message.outgoing = undefined; message.localImages = undefined; message.sendError = undefined;
      this.store!.enrichMessage(message); await this.store!.flush();
    });
    register('qq.insertFile', async () => {
      const store = this.store, files = this.attachments, key = this.target; if (!store || !files || !key) return;
      const selected = await vscode.window.showOpenDialog({ canSelectMany: true, title: '选择要发送的文件' });
      if (!selected?.length || store !== this.store) return;
      const staged: Attachment[] = [];
      try {
        for (const uri of selected) staged.push(await files.stageFilePath(uri.fsPath, path.basename(uri.fsPath)));
        if (store !== this.store) throw new Error('账号已切换，请重新导入');
        await this.attachToDraft(key, staged);
      } catch (error) { await files.discard(staged); throw error; }
    });
    register('qq.restoreTranscript', async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor && this.transcript?.key(editor.document.uri)) { await this.native.sync(editor, true, true); await this.native.focus(editor); }
    });
    register('qq.insertImage', () => this.composer.handleMessage({ type: 'pickImages', account: this.store?.selfId, key: this.target }));
    register('qq.emojis', () => this.composer.showEmojis());
    register('qq.cancelReply', async () => {
      const editor = vscode.window.activeTextEditor;
      const key = editor && this.transcript?.key(editor.document.uri) || this.target;
      if (!key || !this.store) return;
      this.store.setDraft(key, this.store.draft(key).text);
      if (editor && this.transcript?.key(editor.document.uri) === key) await this.native.sync(editor);
    });
    register('qq.latest', () => this.latest());
    register('qq.loadHistory', () => { if (this.target) return this.loadHistory(this.target, true); });
    register('qq.search', async () => {
      const chats = [...this.store?.chats.values() ?? []];
      const selected = await vscode.window.showQuickPick(chats.map(chat => ({ label: chat.name, description: `${chat.type === 'group' ? '群' : '好友'} ${chat.id}`, detail: `${chat.remark ?? ''} ${chat.nickname ?? ''}`, chat })), { placeHolder: '搜索群聊、好友名称或号码', matchOnDescription: true, matchOnDetail: true });
      if (selected) await this.openChat(selected.chat.key);
    });
    register('qq.reply', async (uri?: string, messageId?: string) => {
      const editor = typeof uri === 'string' ? vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === vscode.Uri.parse(uri).toString()) : vscode.window.activeTextEditor;
      if (!editor || !this.store || !this.transcript) return;
      if (!this.native.historyMatches(editor.document)) throw new Error('历史已在本地修改，请先重建聊天文档再回复');
      const key = this.transcript.key(editor.document.uri);
      const msg = key && typeof messageId === 'string' ? this.store.messages.get(key)?.find(m => m.id === messageId) : this.transcript.messageAt(editor.document.uri, editor.selection.active.line);
      if (!key || !msg) return;
      if (!/^-?\d+$/.test(msg.id)) throw new Error('这条消息暂时无法引用');
      this.target = key; this.store.setDraft(key, this.store.draft(key).text, msg.id); await this.native.sync(editor); await this.focusInput();
    });
    register('qq.copyMessage', async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor && !this.native.historyMatches(editor.document)) throw new Error('历史已在本地修改，请先重建聊天文档再复制原文');
      const msg = editor && this.transcript?.messageAt(editor.document.uri, editor.selection.active.line);
      if (msg) await vscode.env.clipboard.writeText(messageText(msg));
    });
    register('qq.downloadFile', async (uri: string, messageId: string, fileIndex: number) => {
      const store = this.store, key = this.transcript?.key(vscode.Uri.parse(uri));
      if (!store || !key || !Number.isInteger(fileIndex) || fileIndex < 0) return;
      const message = store.messages.get(key)?.find(m => m.id === messageId);
      const part = message?.segments.filter(s => s.type === 'text' && s.file)[fileIndex];
      if (!part || part.type !== 'text' || !part.file) throw new Error('文件消息不在当前记录中');
      const ref = part.file;
      const safeName = ref.name.split(/[\\/]/).pop()?.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || 'QQ文件';
      const destination = await vscode.window.showSaveDialog({ title: '保存 QQ 文件', defaultUri: vscode.Uri.file(path.join(os.homedir(), 'Downloads', safeName)) });
      if (!destination || store !== this.store) return;
      const chat = splitKey(key);
      let url = ref.url;
      if (ref.id && this.client.connected) {
        try {
          const result = await this.client.call(chat.type === 'group' ? 'get_group_file_url' : 'get_private_file_url', { file_id: ref.id, ...(chat.type === 'group' ? { group_id: chat.id, busid: ref.busid } : { user_id: chat.id }) });
          if (typeof result?.url === 'string') url = result.url;
        } catch (error) { if (!url) throw error; }
      }
      if (!url) throw new Error('NapCat 未提供文件下载地址，请检查文件是否已过期');
      const source = url;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `下载 ${safeName}`, cancellable: true }, async (progress, token) => {
        const controller = new AbortController();
        const listener = token.onCancellationRequested(() => controller.abort());
        let last = 0;
        try {
          if (token.isCancellationRequested) controller.abort();
          await downloadFile(source, destination.fsPath, AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60 * 1000)]), (bytes, total) => {
            const percent = total ? bytes / total * 100 : 0;
            progress.report({ increment: percent - last, message: `${(bytes / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}` }); last = percent;
          });
        } finally { listener.dispose(); }
      });
      const choice = await vscode.window.showInformationMessage(`文件已保存：${safeName}`, '打开所在文件夹');
      if (choice) await vscode.commands.executeCommand('revealFileInOS', destination);
    });
    register('qq.openImage', async (uri: string, messageId: string, imageIndex: number) => {
      if (!this.transcript || typeof uri !== 'string' || typeof messageId !== 'string') return;
      const file = await this.transcript.image(vscode.Uri.parse(uri), messageId, imageIndex);
      await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(file), 'imagePreview.previewEditor', { preview: true, viewColumn: vscode.ViewColumn.Beside });
    });
    register('qq.openDraftImage', async (uri: string, attachmentId: string) => {
      const key = this.transcript?.key(vscode.Uri.parse(uri));
      const attachment = key && this.store?.draft(key).attachments.find(a => a.id === attachmentId);
      if (!attachment || !this.attachments || !attachment.file) return;
      await this.attachments.read(attachment);
      await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(attachment.file), 'imagePreview.previewEditor', { preview: true, viewColumn: vscode.ViewColumn.Beside });
    });
  }
  attachToDraft(key: string, attachments: Attachment[]): Promise<void> { return this.native.insert(key, attachments); }
  async focusInput(): Promise<void> {
    const key = this.target, chat = key && this.store?.chats.get(key);
    if (!chat || !this.transcript) return;
    const doc = await vscode.workspace.openTextDocument(this.transcript.uri(chat));
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    await this.native.focus(editor);
    this.latest(editor);
  }
  filterList(section: Section, query: string): void {
    this.trees.find(t => t.section === section)?.setFilter(query);
    void vscode.commands.executeCommand('setContext', `qq.${section}.filtered`, !!query.trim());
  }
  private searchList(section: Section): void {
    this.filterInput?.hide();
    const tree = this.trees.find(t => t.section === section)!;
    const old = tree.filter;
    const input = vscode.window.createInputBox(); this.filterInput = input;
    input.title = `搜索${section === 'favorites' ? '收藏' : '列表'}`;
    input.placeholder = '名称或 QQ / 群号；空格分隔多个关键词';
    input.prompt = '输入时筛选列表 · Enter 保留筛选 · Esc 取消 · 列表标题 × 清除';
    input.value = old;
    let accepted = false;
    const changed = input.onDidChangeValue(value => this.filterList(section, value));
    const accept = input.onDidAccept(() => { accepted = true; input.hide(); });
    const hide = input.onDidHide(() => {
      if (!accepted) this.filterList(section, old);
      changed.dispose(); accept.dispose(); hide.dispose(); input.dispose();
      if (this.filterInput === input) this.filterInput = undefined;
    });
    input.show();
  }
  private updateStatus(text: string): void {
    this.status.text = `$(${this.ready ? 'comment-discussion' : 'debug-disconnect'}) QQ · ${text}`;
    this.status.tooltip = 'NapCat / OneBot v11 · 点击重新连接'; this.composer.update();
  }
  private log(error: unknown): void { this.output.appendLine(error instanceof Error ? error.message : 'QQ 操作失败'); }
  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true; clearTimeout(this.initializationRetry); clearInterval(this.cacheTimer); this.mentionDecoration.dispose(); this.replyDecoration.dispose(); clearInterval(this.notificationTimer); this.notifications?.dispose(); this.filterInput?.hide();
    for (const timer of this.scrollGuards.values()) clearTimeout(timer);
    this.client.dispose(); await this.store?.dispose(); this.transcript?.dispose();
    this.disposables.forEach(d => d.dispose());
  }
  dispose(): void { void this.shutdown(); }
}

let app: QQApp | undefined;
export async function activate(context: vscode.ExtensionContext): Promise<{ app: QQApp }> {
  app = new QQApp(context); context.subscriptions.push(app); await app.start(); return { app };
}
export async function deactivate(): Promise<void> { await app?.shutdown(); app = undefined; }
