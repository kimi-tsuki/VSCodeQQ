import type { Draft } from './model';

export const replyPattern = /\[回复:[^\]\r\n]+\]/g;
export const replyToken = (name: string): string => `[回复:${name.replace(/[\r\n\t\u0000-\u001f]/g, ' ').replace(/\[/g, '［').replace(/\]/g, '］') || '消息'}]`;
export function boundReplies(text: string, bindings: Record<string, string> = {}): { token: string; id: string }[] {
  return [...text.matchAll(replyPattern)].flatMap(match => Object.hasOwn(bindings, match[0]) ? [{ token: match[0], id: bindings[match[0]] }] : []);
}
export const removeReplies = (text: string, bindings: Record<string, string> = {}): string => text.replace(replyPattern, token => Object.hasOwn(bindings, token) ? '' : token);
export function outgoingReply(draft: Draft): Draft {
  if (!draft.replies) return draft; // Older queued messages contain replyId without a token.
  const active = boundReplies(draft.text, draft.replies);
  if (new Set(active.map(item => item.id)).size > 1) throw new Error('每条消息只能回复一条原消息，请删除多余的回复占位符');
  return { ...draft, text: removeReplies(draft.text, draft.replies), replyId: active[0]?.id, replyPlaceholder: undefined, replies: undefined };
}
export function restoreReply(draft: Draft): Draft {
  const bindings = Object.fromEntries(Object.entries(draft.replies && typeof draft.replies === 'object' ? draft.replies : {}).filter(([token, id]) => /^\[回复:[^\]\r\n]+\]$/.test(token) && typeof id === 'string' && /^-?\d+$/.test(id) && Number(id) !== 0).slice(-8));
  if (Object.keys(bindings).length || draft.replyPlaceholder) {
    const active = boundReplies(draft.text, bindings)[0];
    return { ...draft, replies: bindings, replyId: active?.id, replyPlaceholder: active?.token };
  }
  if (draft.replyId && /^-?\d+$/.test(draft.replyId) && Number(draft.replyId) !== 0) {
    const token = replyToken('消息 ' + draft.replyId);
    return { ...draft, text: token + draft.text, replyPlaceholder: token, replies: { [token]: draft.replyId } };
  }
  return { ...draft, replyId: undefined, replyPlaceholder: undefined, replies: undefined };
}
