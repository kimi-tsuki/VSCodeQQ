import * as vscode from 'vscode';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ChatStore } from './store';
import { Attachment, inline, messageText } from './model';
import { AttachmentFiles, basicFaces } from './attachments';
import { OneBotClient } from './onebot';
import { Transcript } from './transcript';

export interface ComposerHost {
  store?: ChatStore; target?: string; ready: boolean;
  attachments?: AttachmentFiles; client: OneBotClient; transcript?: Transcript;
  sendMessage(key: string, text: string, replyId?: string): Promise<boolean>;
  checkRead(): void;
  attachToDraft(key: string, attachments: Attachment[]): Promise<void>;
  focusInput(): Promise<void>;
}
export class Composer implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private edits = new Map<string, number>();
  private favoriteSources = new Map<string, { url: string; account: string }>();
  private favoriteRequest = 0;
  focused = false;
  private wantEmojis = false;
  constructor(private context: vscode.ExtensionContext, private host: ComposerHost) {}
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.edits.clear(); this.favoriteSources.clear();
    const webview = view.webview;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    webview.options = { enableScripts: true, localResourceRoots: [media, this.context.globalStorageUri] };
    const nonce = randomBytes(24).toString('hex');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'composer.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'composer.css'));
    webview.html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${style}"></head><body><header><span id="target">从左侧选择会话</span><span id="status"></span></header><div id="reply" hidden><span id="replyText"></span><button id="cancel" title="取消回复">×</button></div><p>在聊天文档底部输入，Enter 发送，Shift/Ctrl+Enter 换行。图片和表情会插入光标处。</p><textarea hidden id="input" aria-label="QQ 消息" placeholder="输入消息或粘贴图片，Enter 发送" maxlength="65536" spellcheck="false" disabled></textarea><div id="attachments" aria-label="待发送附件"></div><footer><div class="tools"><button id="addImage" disabled>图片</button><button id="emojis" disabled>表情</button><span id="hint">Enter 发送</span></div><button id="send" disabled>发送</button></footer><section id="emojiPanel" hidden><div class="emojiHeading">QQ 常用表情 <span>图标为示意，发送 QQ 原生表情</span></div><div id="basicFaces" class="basicGrid"></div><div class="emojiHeading">收藏表情 <button id="reloadFaces">刷新</button></div><div id="favoriteStatus"></div><div id="favoriteFaces" class="faceGrid"></div><button id="moreFaces" hidden>加载更多</button></section><div id="error" role="status"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
    view.onDidDispose(() => { if (this.view === view) { this.view = undefined; this.focused = false; } });
    webview.onDidReceiveMessage(data => { void this.handleMessage(data).catch((error: Error) => this.post({ type: 'error', account: data?.account, key: data?.key, message: error.message })); });
  }
  private post(data: unknown): void { void this.view?.webview.postMessage(data); }
  async handleMessage(data: any): Promise<void> {
    if (data?.type === 'ready') { this.update(); if (this.wantEmojis) { this.post({ type: 'showEmojis' }); this.wantEmojis = false; } return; }
    if (data?.type === 'focus') { this.focused = !!data.value; this.host.checkRead(); return; }
    const store = this.host.store, files = this.host.attachments;
    if (!store || data?.account !== store.selfId || typeof data.key !== 'string' || !store.chats.has(data.key)) return;
    const key: string = data.key;
    if (data.type === 'draft' && typeof data.text === 'string' && data.text.length <= 65536) {
      const version = Number(data.editVersion) || 0;
      if (version < (this.edits.get(key) ?? 0)) return;
      this.edits.set(key, version);
      store.setDraft(key, data.text, store.draft(key).replyId);
    } else if (data.type === 'cancelReply') {
      store.setDraft(key, store.draft(key).text); this.update();
    } else if (data.type === 'send' && typeof data.text === 'string' && data.text.length <= 65536) {
      try { await this.host.sendMessage(key, store.draft(key).text, store.draft(key).replyId); this.update(); }
      finally { this.post({ type: 'sent', account: store.selfId, key }); }
    } else if (data.type === 'pickImages' && files) {
      const uris = await vscode.window.showOpenDialog({ canSelectMany: true, title: '选择要发送的图片', filters: { '图片': ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] } });
      if (!uris?.length || store !== this.host.store) return;
      if (uris.length > 8) throw new Error('每条消息最多附带 8 个图片或表情');
      const attachments = [];
      for (const uri of uris) {
        if ((await fs.stat(uri.fsPath)).size > 16 * 1024 * 1024) throw new Error('单张图片不能超过 16 MB');
        attachments.push(await files.stage(await fs.readFile(uri.fsPath), path.basename(uri.fsPath)));
      }
      if (store !== this.host.store) return;
      await this.host.attachToDraft(key, attachments); this.update();
    } else if (data.type === 'pasteImage' && files && typeof data.base64 === 'string') {
      if (data.base64.length > 24 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.base64)) throw new Error('剪贴板图片过大或格式无效');
      const attachment = await files.stage(Buffer.from(data.base64, 'base64'), '粘贴的图片');
      if (store !== this.host.store) return;
      await this.host.attachToDraft(key, [attachment]); this.update();
    } else if (data.type === 'removeAttachment' && typeof data.id === 'string') {
      store.removeAttachment(key, data.id); this.update();
    } else if (data.type === 'basicFace') {
      const face = basicFaces.find(face => face.id === data.id); if (!face) return;
      await this.host.attachToDraft(key, [{ id: randomUUID(), kind: 'face', label: face.name, faceId: face.id }]); this.update();
    } else if (data.type === 'faces') {
      const request = ++this.favoriteRequest;
      const count = Math.min(500, Math.max(48, Number(data.count) || 48));
      this.post({ type: 'basicFaces', account: store.selfId, key, faces: basicFaces });
      if (!this.host.ready) throw new Error('连接 NapCat 后可读取收藏表情');
      const faces = await this.host.client.call('fetch_custom_face', { count });
      if (store !== this.host.store || request !== this.favoriteRequest) return;
      this.favoriteSources.clear();
      const entries = (Array.isArray(faces) ? faces : []).filter((u: unknown): u is string => typeof u === 'string' && /^https?:\/\//i.test(u)).slice(0, count).map((url: string, i: number) => {
        const id = randomUUID(); this.favoriteSources.set(id, { url, account: store.selfId }); return { id, label: `收藏表情 ${i + 1}` };
      });
      this.post({ type: 'favoriteFaces', account: store.selfId, key, entries, count, more: entries.length >= count && count < 500 });
    } else if (data.type === 'favoritePreview' || data.type === 'favoriteFace') {
      const source = this.favoriteSources.get(data.id);
      if (!source || source.account !== store.selfId || !this.host.transcript || !files) return;
      const file = await this.host.transcript.media.get({ file: '', url: source.url });
      if (store !== this.host.store) return;
      if (data.type === 'favoritePreview') this.post({ type: 'favoritePreview', account: store.selfId, key, id: data.id, src: this.view?.webview.asWebviewUri(vscode.Uri.file(file)).toString() });
      else {
        const attachment = await files.stage(await fs.readFile(file), '收藏表情', true);
        if (store !== this.host.store) return;
        await this.host.attachToDraft(key, [attachment]); this.update();
      }
    }
  }
  update(): void {
    if (!this.view) return;
    const store = this.host.store;
    const key = this.host.target;
    const chat = key && store?.chats.get(key);
    const draft = key ? store?.draft(key) : undefined;
    const reply = draft?.replyId && store?.messages.get(key!)?.find(m => m.id === draft.replyId);
    void this.view.webview.postMessage({ type: 'state', account: store?.selfId, key,
      name: chat ? `${chat.name}（${chat.type === 'group' ? '群' : '好友'} ${chat.id}）` : '',
      ready: this.host.ready, text: draft?.text ?? '', replyId: draft?.replyId, editVersion: key ? this.edits.get(key) ?? 0 : 0,
      attachments: (draft?.attachments ?? []).filter(a => !a.placeholder || draft!.text.includes(a.placeholder)).map(a => ({ id: a.id, kind: a.kind, label: a.placeholder ? `${a.placeholder} ${a.label}` : a.label })),
      replyPreview: reply ? `${inline(reply.senderName)}：${inline(messageText(reply)).slice(0, 120)}` : draft?.replyId ? `消息 ${draft.replyId}` : ''
    });
  }
  async focus(): Promise<void> { await this.host.focusInput(); }
  async showEmojis(): Promise<void> {
    this.wantEmojis = true;
    await vscode.commands.executeCommand('qq.composer.focus');
    this.view?.show(false); this.update(); this.post({ type: 'showEmojis' });
  }
}
