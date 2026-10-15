import { Chat, Message, inline } from './model';
import { CodeLanguage, codeStyle } from './codeStyle';

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
        if (part.type === 'file') rendered.files.push({ line: lines.length, start: current.length, end: current.length + escape(part.text).length, messageId: m.id, fileIndex: fileIndex++ });
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
  if (!messages.length) lines.push(`${style.comment} 暂无消息。`);
  rendered.text = lines.join('\n');
  return rendered;
}
