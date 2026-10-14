import { randomUUID } from 'node:crypto';
import { CodeLanguage, codeStyle } from './codeStyle';

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
export interface FileRef { id: string; name: string; url?: string; busid?: number; size?: number; }
export type Segment = { type: 'text'; text: string; file?: FileRef } | { type: 'image'; image: ImageRef };
export interface Message {
  id: string; chatKey: string; senderId: string; senderName: string;
  time: number; segments: Segment[]; replyId?: string; mentioned: boolean; replyToSelf?: boolean;
  senderTitle?: string; senderRole?: string;
  senderRemark?: string; senderNickname?: string;
  sendState?: 'queued' | 'sending' | 'sent' | 'failed' | 'uncertain' | 'cancelled';
  sendError?: string;
  sendProgress?: { stage: 'upload' | 'confirm'; sent: number; total: number; bytesPerSecond?: number };
  outgoing?: Draft;
  localImages?: Attachment[];
  fileIds?: string[];
}
export interface Member { id: string; name: string; title: string; role: string; nickname?: string; }
export interface Attachment { id: string; kind: 'image' | 'face' | 'file'; label: string; size?: number; file?: string; faceId?: string; sticker?: boolean; placeholder?: string; }
export interface Draft { text: string; replyId?: string; version: number; attachments: Attachment[]; }
export const emptyDraft = (): Draft => ({ text: '', version: 0, attachments: [] });
export const attachmentPattern = /\[(?:(?:图片|表情):\d+|文件:[^\]\r\n]+)\]/g;
export function draftParts(text: string, attachments: Attachment[]): (string | Attachment)[] {
  const parts: (string | Attachment)[] = []; let offset = 0, count = 0;
  for (const match of text.matchAll(attachmentPattern)) {
    const attachment = attachments.find(a => a.placeholder === match[0]);
    if (!attachment) throw new Error(`占位符 ${match[0]} 没有对应附件，请重新导入或删除它`);
    if (++count > 8) throw new Error('每条消息最多发送 8 个附件（含重复占位符）');
    if (match.index! > offset) parts.push(text.slice(offset, match.index));
    parts.push(attachment); offset = match.index! + match[0].length;
  }
  if (offset < text.length) parts.push(text.slice(offset));
  // Compatibility with drafts saved by 0.1.0, before inline placeholders existed.
  parts.push(...attachments.filter(a => !a.placeholder));
  return parts;
}
// File uploads are independent operations so retries never resend successful neighbours.
export function outgoingDrafts(draft: Draft): Draft[] {
  const parts = draftParts(draft.text, draft.attachments);
  if (!parts.some(p => typeof p !== 'string' && p.kind === 'file')) return [draft];
  const result: Draft[] = []; let chunk: (string | Attachment)[] = [];
  const flush = () => {
    if (!chunk.length) return;
    const text = chunk.map(p => typeof p === 'string' ? p : p.placeholder ?? '').join('');
    const attachments = chunk.filter((p): p is Attachment => typeof p !== 'string');
    if (text.trim() || attachments.length) result.push({ ...draft, text, attachments, replyId: result.length ? undefined : draft.replyId });
    chunk = [];
  };
  for (const part of parts) {
    if (typeof part !== 'string' && part.kind === 'file') {
      flush(); result.push({ ...draft, text: part.placeholder ?? '', attachments: [part], replyId: undefined });
    } else chunk.push(part);
  }
  flush(); return result;
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
      case 'file': {
        const name = inline(data.name || data.file_name || '文件');
        result.segments.push({ type: 'text', text: `[文件:${name}]`, file: { id: id(data.file_id ?? data.file), name, url: typeof data.url === 'string' ? data.url : undefined, busid: Number(data.busid ?? data.bus_id) || undefined, size: Number(data.size ?? data.file_size) || undefined } });
        const fileId = id(data.file_id ?? data.file); if (fileId) (result.fileIds ??= []).push(fileId);
        break;
      }
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
export const isPending = (m: Message): boolean => !!m.outgoing && !['sent', 'cancelled'].includes(m.sendState ?? '');
export function mergeMessages(history: Message[], live: Message[], limit: number): Message[] {
  const values = new Map<string, Message>();
  for (const item of [...history, ...live]) values.set(item.id, item);
  const sorted = [...values.values()].sort((a, b) => a.time - b.time);
  const retained = sorted.filter(m => !isPending(m)).slice(-limit);
  return [...retained, ...sorted.filter(isPending)].sort((a, b) => a.time - b.time);
}

export interface Span { line: number; start: number; end: number; messageId: string; imageIndex: number; }
export interface Rendered { text: string; images: Span[]; files: { line: number; start: number; end: number; messageId: string; fileIndex: number }[]; actions: { line: number; start: number; messageId: string; kind: 'reply' | 'retry' | 'cancel' }[]; messages: Map<number, string>; starts: Map<string, number>; ownLines: number[]; attentionLines: number[]; mentionLines: number[]; replyLines: number[]; }
// Escape only the display projection; copy/reply/send continue using the original message.
export const codeString = (text: string): string => JSON.stringify(text).slice(1, -1)
  .replace(/[\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
export function renderTranscript(chat: Chat, messages: Message[], selfId: string, language: CodeLanguage = 'c'): Rendered {
  const style = codeStyle(language);
  const escape = (text: string) => style.escape(codeString(text));
  const quote = (text: string) => `"${escape(text)}"`;
  const lines = [style.constant('CHAT_NAME', [quote(chat.name)]), style.constant(chat.type === 'group' ? 'GROUP_ID' : 'FRIEND_ID', [quote(chat.id)]), `${style.comment} 底部草稿 Enter 发送 · Shift/Ctrl+Enter 换行 · 右键回复 · 图片悬浮预览`, ''];
  const rendered: Rendered = { text: '', images: [], files: [], actions: [], messages: new Map(), starts: new Map(), ownLines: [], attentionLines: [], mentionLines: [], replyLines: [] };
  const byId = new Map(messages.map(m => [m.id, m]));
  let lastDay = '';
  for (const m of messages) {
    const date = new Date(m.time * 1000);
    const day = Number.isFinite(date.getTime()) ? date.toLocaleDateString('zh-CN') : '';
    if (day && day !== lastDay) { lines.push(`${style.comment} ── ${day} ──`, ''); lastDay = day; }
    const start = lines.length;
    rendered.starts.set(m.id, start);
    const stamp = Number.isFinite(date.getTime()) ? date.toLocaleTimeString('zh-CN', { hour12: false }) : '--:--:--';
    const self = m.senderId === selfId;
    const target = m.replyId ? byId.get(m.replyId) : undefined;
    const tags = [self ? '我' : '', m.senderRole === 'owner' ? '群主' : m.senderRole === 'admin' ? '管理员' : '', !self && m.mentioned ? '@我' : '', !self && (m.replyToSelf || target?.senderId === selfId) ? '回复我' : ''].filter(Boolean);
    const sender = quote(m.senderName);
    let state = m.sendState ? ({ queued: '等待发送…', sending: '发送中…', sent: '✓ 已发送', failed: '发送失败 · [重试]', uncertain: '结果未确认 · [重试]', cancelled: '已取消' })[m.sendState] : '';
    if (m.sendState === 'sending' && m.sendProgress) {
      const p = m.sendProgress, percent = p.total ? Math.min(100, Math.floor(p.sent / p.total * 100)) : 0;
      const filled = Math.floor(percent / 10);
      state = p.stage === 'confirm' ? '文件已传至 NapCat · 等待 QQ 确认…' : `上传到 NapCat [${'█'.repeat(filled)}${'░'.repeat(10 - filled)}] ${percent}% · ${(p.sent / 1048576).toFixed(1)}/${(p.total / 1048576).toFixed(1)} MB${p.bytesPerSecond ? ` · ${(p.bytesPerSecond / 1048576).toFixed(2)} MB/s` : ''}`;
    }
    lines.push(style.constant('INFO', [quote(m.senderTitle || ''), sender, quote(stamp)]));
    const details: string[] = [];
    if (m.senderRemark && m.senderRemark !== m.senderName) details.push(`备注：${inline(m.senderRemark)}`);
    if (m.senderNickname && m.senderNickname !== m.senderName && m.senderNickname !== m.senderRemark) details.push(`昵称：${inline(m.senderNickname)}`);
    if (details.length) lines.push(`${style.comment} ${details.join(' · ')}`);
    const fn = self ? (m.replyId ? 'send_reply' : 'send') : (m.replyId ? 'reply' : 'recv');
    lines.push(`${style.function(`${fn}_${/^\d+$/.test(m.senderId) ? m.senderId : 'unknown'}`)}${tags.length ? `  ${style.comment} ${tags.join(' · ')}` : ''}`);
    if (m.replyId) {
      let replay = style.string('replay');
      if (target) {
        replay += escape(`${target.senderName}：`);
        let remaining = 160, replyImageIndex = 0, truncated = false;
        for (const part of target.segments) {
          if (part.type === 'image') {
            rendered.images.push({ line: lines.length, start: replay.length, end: replay.length + 4, messageId: target.id, imageIndex: replyImageIndex++ });
            replay += '[图片]';
          } else {
            replay += escape(part.text.slice(0, remaining));
            if (part.text.length > remaining && !truncated) { replay += '…'; truncated = true; }
            remaining = Math.max(0, remaining - part.text.length);
          }
        }
      } else replay += escape(`回复消息 ${m.replyId}（未加载）`);
      lines.push(replay + style.stringEnd);
    }
    let current = style.string('msg');
    let imageIndex = 0, fileIndex = 0;
    for (const part of m.segments) {
      if (part.type === 'image') {
        rendered.images.push({ line: lines.length, start: current.length, end: current.length + 4, messageId: m.id, imageIndex: imageIndex++ });
        current += '[图片]';
      } else {
        if (part.file) rendered.files.push({ line: lines.length, start: current.length, end: current.length + escape(part.text).length, messageId: m.id, fileIndex: fileIndex++ });
        const parts = part.text.split('\n');
        current += escape(parts[0]);
        for (const next of parts.slice(1)) { lines.push(current + '\\n"' + style.join); current = style.continuation + escape(next); }
      }
    }
    current += style.stringEnd;
    if (/^-?\d+$/.test(m.id) && m.id !== '0') {
      current += `  ${style.comment} [回复]`;
      rendered.actions.push({ line: lines.length, start: current.lastIndexOf('[回复]'), messageId: m.id, kind: 'reply' });
    }
    lines.push(current);
    const ending = `${style.ending}${state ? `  ${style.comment} ${state}` : ''}`;
    if (ending.includes('[重试]')) rendered.actions.push({ line: lines.length, start: ending.indexOf('[重试]'), messageId: m.id, kind: 'retry' });
    const cancellable = m.sendState === 'queued' || (m.sendState === 'sending' && m.sendProgress?.stage === 'upload');
    const footer = ending + (cancellable ? ' · [取消]' : '');
    if (cancellable) rendered.actions.push({ line: lines.length, start: footer.indexOf('[取消]'), messageId: m.id, kind: 'cancel' });
    lines.push(footer);
    for (let line = start; line < lines.length; line++) { rendered.messages.set(line, m.id); if (self) rendered.ownLines.push(line); else if (m.mentioned || m.replyToSelf || target?.senderId === selfId) { rendered.attentionLines.push(line); (m.mentioned ? rendered.mentionLines : rendered.replyLines).push(line); } }
    lines.push('');
  }
  if (!messages.length) lines.push(`${style.comment} 暂无消息，正在读取历史或等待新消息。`);
  rendered.text = lines.join('\n');
  return rendered;
}
