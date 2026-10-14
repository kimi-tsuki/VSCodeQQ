import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Attachment, Chat, Draft, Member, Message, emptyDraft, id, inline, mergeMessages, messageText, splitKey } from './model';

export class ChatStore extends EventEmitter {
  readonly chats = new Map<string, Chat>();
  readonly messages = new Map<string, Message[]>();
  readonly favorites = new Set<string>();
  readonly drafts = new Map<string, Draft>();
  readonly members = new Map<string, Map<string, Member>>();
  private loaded = new Set<string>();
  private loading = new Map<string, Promise<void>>();
  private dirty = new Set<string>();
  private stateDirty = false;
  private saveTimer?: NodeJS.Timeout;
  private saving: Promise<void> = Promise.resolve();
  private attachmentSerial = 0;
  constructor(readonly folder: string, readonly selfId: string, readonly limit = 500) { super(); }
  async restore(): Promise<void> {
    try {
      const data = JSON.parse(await fs.readFile(path.join(this.folder, 'state.json'), 'utf8'));
      this.attachmentSerial = Number(data.attachmentSerial) || 0;
      for (const chat of data.chats ?? []) { try { splitKey(chat.key); this.chats.set(chat.key, { ...chat, notification: 'unknown' }); } catch {} }
      for (const key of data.favorites ?? []) if (this.chats.has(key)) this.favorites.add(key);
      for (const [key, draft] of Object.entries(data.drafts ?? {})) {
        const d = draft as Draft;
        if (this.chats.has(key) && typeof d.text === 'string') this.drafts.set(key, { text: d.text, replyId: d.replyId, version: Number(d.version) || 0, attachments: Array.isArray(d.attachments) ? d.attachments : [] });
      }
    } catch (error: any) { if (error.code !== 'ENOENT') this.emit('storageError', new Error('本地会话缓存无法读取，已使用空缓存')); }
  }
  private file(key: string): string { const c = splitKey(key); return path.join(this.folder, `${c.type}-${c.id}.json`); }
  async load(key: string): Promise<void> {
    if (this.loaded.has(key)) return;
    const existing = this.loading.get(key); if (existing) return existing;
    const task = (async () => {
      try {
        const cached: Message[] = JSON.parse(await fs.readFile(this.file(key), 'utf8'));
        const valid = Array.isArray(cached) ? cached.filter(m => m.chatKey === key && typeof m.id === 'string' && Array.isArray(m.segments)) : [];
        for (const m of valid) if (m.sendState === 'sending' || m.sendState === 'queued') {
          m.sendState = 'uncertain'; m.sendError = '插件上次关闭时尚未确认结果，请检查聊天记录后再重试';
        }
        this.messages.set(key, mergeMessages(valid, this.messages.get(key) ?? [], this.limit));
      } catch (error: any) { if (error.code !== 'ENOENT') this.emit('storageError', new Error('部分聊天缓存无法读取')); }
      this.loaded.add(key); this.loading.delete(key);
    })();
    this.loading.set(key, task); await task;
  }
  upsert(chat: Chat): void {
    const current = this.chats.get(chat.key);
    this.chats.set(chat.key, current ? { ...current, name: chat.name, remark: chat.remark ?? current.remark, nickname: chat.nickname ?? current.nickname } : chat);
    this.changed(chat.key);
  }
  history(key: string, messages: Message[]): void {
    this.messages.set(key, mergeMessages(messages, this.messages.get(key) ?? [], this.limit));
    this.dirty.add(key); this.changed(key);
  }
  setMembers(key: string, data: any[]): void {
    const members = new Map<string, Member>();
    for (const m of data) if (/^\d+$/.test(id(m.user_id))) members.set(id(m.user_id), {
      id: id(m.user_id), name: inline(m.card || m.nickname || m.user_id), title: inline(m.title), nickname: inline(m.nickname),
      role: ['owner', 'admin', 'member'].includes(m.role) ? m.role : 'member'
    });
    this.members.set(key, members); this.emit('change', key);
  }
  displayMessages(key: string): Message[] {
    return (this.messages.get(key) ?? []).map(message => {
      const member = this.members.get(key)?.get(message.senderId);
      let name = member?.name || message.senderName;
      const friend = message.senderId !== this.selfId && this.chats.get(`private:${message.senderId}`);
      if (friend && key.startsWith('private:')) name = friend.name;
      return { ...message, senderName: name, senderRemark: friend ? friend.remark : undefined, senderNickname: member?.nickname || message.senderNickname || (friend ? friend.nickname : undefined), senderTitle: member?.title || message.senderTitle, senderRole: member?.role || message.senderRole };
    });
  }
  add(message: Message, countUnread: boolean): boolean {
    const current = this.messages.get(message.chatKey) ?? [];
    if (current.some(m => m.id === message.id)) return false;
    this.messages.set(message.chatKey, mergeMessages([], [...current, message], this.limit));
    const chat = this.chats.get(message.chatKey);
    if (chat) {
      if (message.time >= chat.lastTime) { chat.lastTime = message.time; chat.preview = messageText(message).replace(/\s+/g, ' ').slice(0, 100); }
      if (countUnread && message.senderId !== this.selfId) {
        chat.unread++; chat.mentioned ||= message.mentioned;
        chat.replied ||= !!message.replyId && current.some(m => m.id === message.replyId && m.senderId === this.selfId);
      }
    }
    this.dirty.add(message.chatKey); this.changed(message.chatKey); return true;
  }
  markRead(key: string): void {
    const chat = this.chats.get(key);
    if (chat && (chat.unread || chat.mentioned || chat.replied)) { chat.unread = 0; chat.mentioned = false; chat.replied = false; this.changed(key); }
  }
  markReplyToSelf(key: string): void {
    const chat = this.chats.get(key);
    if (chat?.unread && !chat.replied) { chat.replied = true; this.changed(key); }
  }
  enrichMessage(message: Message): void {
    const messages = this.messages.get(message.chatKey);
    const index = messages?.findIndex(m => m.id === message.id) ?? -1;
    if (!messages || index < 0) return;
    messages[index] = { ...messages[index], ...message };
    this.dirty.add(message.chatKey); this.changed(message.chatKey);
  }
  settleOutgoing(key: string, localId: string, confirmed: Message): Message {
    const current = this.messages.get(key) ?? [];
    const local = current.find(m => m.id === localId);
    const echo = current.find(m => m.id === confirmed.id && m.id !== localId);
    const message: Message = { ...confirmed, ...echo, sendState: 'sent', localImages: local?.localImages, outgoing: undefined, sendError: undefined };
    this.messages.set(key, mergeMessages([], [...current.filter(m => m.id !== localId && m.id !== confirmed.id), message], this.limit));
    this.dirty.add(key); this.changed(key); return message;
  }
  setNotification(key: string, notification: Chat['notification']): void {
    const chat = this.chats.get(key);
    if (chat && chat.notification !== notification) { chat.notification = notification; this.changed(key); }
  }
  toggleIgnoreUnread(key: string): void {
    const chat = this.chats.get(key);
    if (chat) { chat.ignoreUnread = !chat.ignoreUnread; this.changed(key); }
  }
  toggleFavorite(key: string): void {
    if (!this.chats.has(key)) return;
    if (this.favorites.has(key)) this.favorites.delete(key); else this.favorites.add(key);
    this.changed(key);
  }
  draft(key: string): Draft { return this.drafts.get(key) ?? emptyDraft(); }
  setDraft(key: string, text: string, replyId?: string, attachments = this.draft(key).attachments): Draft {
    const replyChanged = this.draft(key).replyId !== replyId;
    const next = { text, replyId, attachments, version: this.draft(key).version + 1 };
    this.drafts.set(key, next); this.schedule(); this.emit('draft', key, replyChanged); return next;
  }
  clearDraftIfVersion(key: string, version: number): boolean {
    if (this.draft(key).version !== version) return false;
    this.setDraft(key, '', undefined, []); return true;
  }
  completeSend(key: string, captured: Draft): boolean {
    if (this.clearDraftIfVersion(key, captured.version)) return true;
    const sent = new Set(captured.attachments.map(a => a.id));
    const current = this.draft(key);
    const keep = (a: Attachment) => !sent.has(a.id) || !!(a.placeholder && current.text.includes(a.placeholder));
    if (current.attachments.some(a => !keep(a))) this.setDraft(key, current.text, current.replyId, current.attachments.filter(keep));
    return false;
  }
  attach(key: string, attachments: Attachment[]): void {
    const prepared = this.prepareAttachments(key, attachments);
    const draft = this.draft(key);
    this.setDraft(key, draft.text + prepared.map(a => a.placeholder).join(''), draft.replyId);
  }
  prepareAttachments(key: string, attachments: Attachment[]): Attachment[] {
    const draft = this.draft(key);
    const used = draft.text.match(/\[(?:图片|表情):\d+\]/g)?.length ?? 0;
    if (used + attachments.length > 8) throw new Error('每条消息最多附带 8 个图片或表情');
    const prepared = attachments.map(a => ({ ...a, placeholder: `[${a.kind === 'image' ? '图片' : '表情'}:${++this.attachmentSerial}]` }));
    // Retain a small number of removed tokens so undo/redo can restore their attachments.
    const retained = draft.attachments.filter(a => !a.placeholder || draft.text.includes(a.placeholder));
    const orphaned = draft.attachments.filter(a => a.placeholder && !draft.text.includes(a.placeholder)).slice(-48);
    this.setDraft(key, draft.text, draft.replyId, [...retained, ...orphaned, ...prepared]);
    return prepared;
  }
  removeAttachment(key: string, id: string): void {
    const draft = this.draft(key), attachment = draft.attachments.find(a => a.id === id);
    const text = attachment?.placeholder ? draft.text.split(attachment.placeholder).join('') : draft.text;
    this.setDraft(key, text, draft.replyId, draft.attachments.filter(a => a.id !== id));
  }
  private changed(key: string): void { this.schedule(); this.emit('change', key); }
  private schedule(): void {
    this.stateDirty = true;
    if (!this.saveTimer) this.saveTimer = setTimeout(() => { this.saveTimer = undefined; void this.flush(); }, 1200);
  }
  async flush(): Promise<void> {
    clearTimeout(this.saveTimer); this.saveTimer = undefined;
    this.saving = this.saving.then(async () => {
      if (!this.stateDirty && !this.dirty.size) return;
      const keys = [...this.dirty]; this.dirty.clear(); this.stateDirty = false;
      try {
        await fs.mkdir(this.folder, { recursive: true });
        for (const key of keys) {
          // Merge unread-on-disk messages before persisting a newly received event.
          await this.load(key);
          await this.atomic(this.file(key), this.messages.get(key) ?? []);
        }
        await this.atomic(path.join(this.folder, 'state.json'), {
          version: 1, attachmentSerial: this.attachmentSerial, chats: [...this.chats.values()], favorites: [...this.favorites],
          drafts: Object.fromEntries([...this.drafts].filter(([, d]) => d.text || d.replyId || d.attachments.length))
        });
      } catch {
        keys.forEach(key => this.dirty.add(key)); this.stateDirty = true;
        this.emit('storageError', new Error('缓存保存失败，消息仍保留在内存中'));
      }
    });
    await this.saving;
  }
  private async atomic(file: string, data: unknown): Promise<void> {
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data), 'utf8'); await fs.rename(tmp, file);
  }
  async dispose(): Promise<void> { await this.flush(); this.removeAllListeners(); }
}
