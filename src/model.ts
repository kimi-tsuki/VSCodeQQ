import { randomUUID } from 'node:crypto';

export type ChatType = 'group' | 'private';
export interface Chat {
  key: string; id: string; type: ChatType; name: string;
  unread: number; mentioned: boolean; lastTime: number; preview: string;
  replied?: boolean;
  notification?: 'notify' | 'muted' | 'unknown';
  ignoreUnread?: boolean;
  remark?: string; nickname?: string;
}
export interface ImageRef { file: string; url?: string; }
export type Segment = { type: 'text'; text: string } | { type: 'image'; image: ImageRef };
export interface Message {
  id: string; chatKey: string; senderId: string; senderName: string;
  time: number; segments: Segment[]; replyId?: string; mentioned: boolean;
  senderTitle?: string; senderRole?: string;
  senderRemark?: string; senderNickname?: string;
  sendState?: 'queued' | 'sending' | 'sent' | 'failed' | 'uncertain';
  sendError?: string;
  outgoing?: Draft;
  localImages?: Attachment[];
}
export interface Member { id: string; name: string; title: string; role: string; nickname?: string; }
export interface Attachment { id: string; kind: 'image' | 'face'; label: string; file?: string; faceId?: string; sticker?: boolean; placeholder?: string; }
export interface Draft { text: string; replyId?: string; version: number; attachments: Attachment[]; }
export const emptyDraft = (): Draft => ({ text: '', version: 0, attachments: [] });
export function draftParts(text: string, attachments: Attachment[]): (string | Attachment)[] {
  const parts: (string | Attachment)[] = []; let offset = 0, count = 0;
  for (const match of text.matchAll(/\[(?:图片|表情):\d+\]/g)) {
    const attachment = attachments.find(a => a.placeholder === match[0]);
    if (!attachment) throw new Error(`占位符 ${match[0]} 没有对应附件，请重新导入或删除它`);
    if (++count > 8) throw new Error('每条消息最多发送 8 个图片或表情（含重复占位符）');
    if (match.index! > offset) parts.push(text.slice(offset, match.index));
    parts.push(attachment); offset = match.index! + match[0].length;
  }
  if (offset < text.length) parts.push(text.slice(offset));
  // Compatibility with drafts saved by 0.1.0, before inline placeholders existed.
  parts.push(...attachments.filter(a => !a.placeholder));
  return parts;
}
export const inline = (text: unknown): string => String(text ?? '').replace(/[\r\n\t\u0000-\u0008\u000b-\u001f\u2028\u2029]/g, ' ');
export function id(value: unknown): string { return typeof value === 'number' || typeof value === 'string' ? String(value) : ''; }
export function chatKey(type: ChatType, value: unknown): string { return `${type}:${id(value)}`; }
export function splitKey(key: string): { type: ChatType; id: string } {
  const match = /^(group|private):(\d+)$/.exec(key);
  if (!match) throw new Error('无效的会话标识');
  return { type: match[1] as ChatType, id: match[2] };
}
export function newChat(type: ChatType, value: unknown, name: unknown): Chat {
  const key = chatKey(type, value); splitKey(key);
  return { key, type, id: id(value), name: inline(name) || id(value), unread: 0, mentioned: false, lastTime: 0, preview: '' };
}
export function parseMessage(raw: any, key?: string, selfId = ''): Message {
  if (!raw || typeof raw !== 'object') throw new Error('无效的消息');
  const type: ChatType = raw.message_type === 'group' ? 'group' : 'private';
  const senderId = id(raw.sender?.user_id ?? raw.user_id);
  // NapCat's own private-message events identify the recipient with target_id.
  const target = type === 'group' ? raw.group_id : (senderId === selfId ? (raw.target_id ?? raw.user_id) : raw.user_id);
  const result: Message = {
    id: id(raw.message_id) && id(raw.message_id) !== '0' ? id(raw.message_id) : `local:${randomUUID()}`,
    chatKey: key ?? chatKey(type, target), senderId,
    senderName: inline(raw.sender?.card || raw.sender?.nickname || senderId),
    time: Number.isFinite(Number(raw.time)) ? Number(raw.time) : Math.floor(Date.now() / 1000),
    segments: [], mentioned: false
  };
  result.senderTitle = inline(raw.sender?.title);
  result.senderNickname = inline(raw.sender?.nickname);
  result.senderRole = ['owner', 'admin', 'member'].includes(raw.sender?.role) ? raw.sender.role : undefined;
  splitKey(result.chatKey);
  const input = Array.isArray(raw.message) ? raw.message : [{ type: 'text', data: { text: String(raw.message ?? raw.raw_message ?? '') } }];
  for (const part of input) {
    if (!part || typeof part !== 'object') continue;
    const data = part.data ?? {};
    switch (part.type) {
      case 'text': result.segments.push({ type: 'text', text: String(data.text ?? '').replace(/\r\n?/g, '\n').replace(/\0/g, '') }); break;
      case 'image': result.segments.push({ type: 'image', image: { file: String(data.file ?? data.file_id ?? ''), url: typeof data.url === 'string' ? data.url : undefined } }); break;
      case 'reply': result.replyId = id(data.id) || undefined; break;
      case 'at': {
        const qq = id(data.qq);
        result.mentioned ||= qq === selfId || qq === 'all';
        result.segments.push({ type: 'text', text: qq === 'all' ? '@全体成员' : `@${inline(data.name || qq)}` });
        break;
      }
      default: {
        const names: Record<string, string> = { face: '表情', mface: '表情', sface: '表情', video: '视频', record: '语音', forward: '合并转发', file: '文件', json: '卡片', xml: '卡片' };
        result.segments.push({ type: 'text', text: `[${names[part.type] ?? '消息'}${part.type === 'file' && data.name ? `：${inline(data.name)}` : part.type === 'face' ? `:${inline(data.id)}` : ''}]` });
      }
    }
  }
  return result;
}
export const messageText = (message: Message): string => message.segments.map(s => s.type === 'text' ? s.text : '[图片]').join('');
export function mergeMessages(history: Message[], live: Message[], limit: number): Message[] {
  const values = new Map<string, Message>();
  for (const item of [...history, ...live]) values.set(item.id, item);
  return [...values.values()].sort((a, b) => a.time - b.time).slice(-limit);
}

export interface Span { line: number; start: number; end: number; messageId: string; imageIndex: number; }
export interface Rendered { text: string; images: Span[]; actions: { line: number; start: number; messageId: string; kind: 'reply' | 'retry' }[]; messages: Map<number, string>; starts: Map<string, number>; ownLines: number[]; }
// Escape only the display projection; copy/reply/send continue using the original message.
export const codeString = (text: string): string => JSON.stringify(text).slice(1, -1)
  .replace(/[\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
export function renderTranscript(chat: Chat, messages: Message[], selfId: string): Rendered {
  const lines = [`#define CHAT_NAME "${codeString(chat.name)}"`, `#define ${chat.type === 'group' ? 'GROUP_ID' : 'FRIEND_ID'} "${chat.id}"`, '// 底部草稿 Enter 发送 · Shift/Ctrl+Enter 换行 · 右键回复 · 图片悬浮预览', ''];
  const rendered: Rendered = { text: '', images: [], actions: [], messages: new Map(), starts: new Map(), ownLines: [] };
  const byId = new Map(messages.map(m => [m.id, m]));
  let lastDay = '';
  for (const m of messages) {
    const date = new Date(m.time * 1000);
    const day = Number.isFinite(date.getTime()) ? date.toLocaleDateString('zh-CN') : '';
    if (day && day !== lastDay) { lines.push(`// ── ${day} ──`, ''); lastDay = day; }
    const start = lines.length;
    rendered.starts.set(m.id, start);
    const stamp = Number.isFinite(date.getTime()) ? date.toLocaleTimeString('zh-CN', { hour12: false }) : '--:--:--';
    const self = m.senderId === selfId;
    const target = m.replyId ? byId.get(m.replyId) : undefined;
    const tags = [self ? '我' : '', m.senderRole === 'owner' ? '群主' : m.senderRole === 'admin' ? '管理员' : '', !self && m.mentioned ? '@我' : '', !self && target?.senderId === selfId ? '回复我' : ''].filter(Boolean);
    const sender = codeString(m.senderName);
    const state = m.sendState ? ({ queued: '等待发送…', sending: '发送中…', sent: '✓ 已发送', failed: '发送失败 · [重试]', uncertain: '结果未确认 · [重试]' })[m.sendState] : '';
    lines.push(`#define INFO "${codeString(m.senderTitle || '')}" "${sender}" "${stamp}"`);
    const details: string[] = [];
    if (m.senderRemark && m.senderRemark !== m.senderName) details.push(`备注：${inline(m.senderRemark)}`);
    if (m.senderNickname && m.senderNickname !== m.senderName && m.senderNickname !== m.senderRemark) details.push(`昵称：${inline(m.senderNickname)}`);
    if (details.length) lines.push(`// ${details.join(' · ')}`);
    const fn = self ? (m.replyId ? 'send_reply' : 'send') : (m.replyId ? 'reply' : 'recv');
    lines.push(`void ${fn}_${/^\d+$/.test(m.senderId) ? m.senderId : 'unknown'}(void) {${tags.length ? `  // ${tags.join(' · ')}` : ''}`);
    if (m.replyId) {
      lines.push(`    char replay[] = "${codeString(target ? `${target.senderName}：${messageText(target).slice(0, 160)}` : `回复消息 ${m.replyId}（未加载）`)}";`);
    }
    let current = '    char msg[] = "';
    let imageIndex = 0;
    for (const part of m.segments) {
      if (part.type === 'image') {
        rendered.images.push({ line: lines.length, start: current.length, end: current.length + 4, messageId: m.id, imageIndex: imageIndex++ });
        current += '[图片]';
      } else {
        const parts = part.text.split('\n');
        current += codeString(parts[0]);
        for (const next of parts.slice(1)) { lines.push(current + '\\n"'); current = `                 "${codeString(next)}`; }
      }
    }
    current += '";';
    if (/^-?\d+$/.test(m.id) && m.id !== '0') {
      current += '  // [回复]';
      rendered.actions.push({ line: lines.length, start: current.lastIndexOf('[回复]'), messageId: m.id, kind: 'reply' });
    }
    lines.push(current);
    const ending = `}${state ? `  // ${state}` : ''}`;
    if (ending.includes('[重试]')) rendered.actions.push({ line: lines.length, start: ending.indexOf('[重试]'), messageId: m.id, kind: 'retry' });
    lines.push(ending);
    for (let line = start; line < lines.length; line++) { rendered.messages.set(line, m.id); if (self) rendered.ownLines.push(line); }
    lines.push('');
  }
  if (!messages.length) lines.push('// 暂无消息，正在读取历史或等待新消息。');
  rendered.text = lines.join('\n');
  return rendered;
}
