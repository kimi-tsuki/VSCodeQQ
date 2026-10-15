import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ChatStore } from '../src/store';
import { newChat, parseMessage, mergeMessages } from '../src/model';
import { renderTranscript } from '../src/transcriptRenderer';
import { codeLanguages, codeStyle } from '../src/codeStyle';

test('撤回保留文字、图片和回复；缓存恢复及迟到历史/详情不覆盖撤回状态', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-recall-'));
  const store = new ChatStore(folder, '123');
  try {
    const chat = newChat('group', 1, '群'); store.upsert(chat);
    const original = parseMessage({ message_id: 20, user_id: 456, message: [
      { type: 'reply', data: { id: 10 } }, { type: 'text', data: { text: '原文\n第二行' } },
      { type: 'image', data: { file: 'a.png' } }, { type: 'at', data: { qq: 123 } }
    ] }, chat.key, '123');
    original.localImages = [{ id: 'a', kind: 'image', label: '图片', file: '/local/a.png' }];
    store.add(original, true);
    store.recall(chat.key, original.id); store.recall(chat.key, original.id);
    const recalled = store.messages.get(chat.key)![0];
    assert.equal(recalled.recalled, true);
    assert.deepEqual(recalled.segments, original.segments);
    assert.deepEqual(recalled.localImages, original.localImages);
    assert.equal(recalled.replyId, '10');
    assert.equal(chat.preview, '[消息已撤回]');
    assert.equal(chat.unread, 1, '撤回不新增未读');
    store.enrichMessage({ ...original, segments: [{ type: 'text', text: '迟到详情' }] });
    store.history(chat.key, [original]);
    assert.equal(store.messages.get(chat.key)![0], recalled);
    assert.equal(mergeMessages([recalled], [original], 50)[0], recalled);
    assert.equal(mergeMessages([original], [recalled], 50)[0], recalled);
    await store.flush();
    const restored = new ChatStore(folder, '123');
    try {
      await restored.restore(); await restored.load(chat.key);
      assert.equal(restored.messages.get(chat.key)![0].recalled, true);
      assert.equal(JSON.stringify(restored.messages.get(chat.key)![0].segments), JSON.stringify(original.segments));
    } finally { await restored.dispose(); }
  } finally { await store.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});

test('撤回块涵盖 DATE 到结尾注释，覆盖自己/提及/回复高亮且不染相邻消息', () => {
  const chat = newChat('group', 1, '群');
  const base = parseMessage({ message_id: 10, user_id: 123, message: '自己的原文' }, chat.key, '123');
  const reply = parseMessage({ message_id: 11, user_id: 456, message: [
    { type: 'reply', data: { id: 10 } }, { type: 'at', data: { qq: 123 } },
    { type: 'text', data: { text: '第一行\n第二行' } }, { type: 'image', data: { file: 'b.png' } }
  ] }, chat.key, '123');
  base.recalled = true; reply.recalled = true;
  const next = { ...base, id: '12', recalled: false };
  for (const language of codeLanguages) {
    const rendered = renderTranscript(chat, [base, reply, next], '123', language);
    const lines = rendered.text.split('\n');
    for (const message of [base, reply]) {
      const block = rendered.recalledLines.filter(line => rendered.messages.get(line) === message.id);
      assert.equal(block[0], rendered.starts.get(message.id));
      assert.equal(lines[block.at(-1)!], codeStyle(language).comment + ' 已撤回');
      assert.equal(lines[block.at(-2)!], codeStyle(language).ending);
      assert.ok(block.every((line, index) => line === block[0] + index));
      assert.ok(!rendered.actions.some(a => a.messageId === message.id));
    }
    assert.ok(!rendered.recalledLines.includes(rendered.starts.get(next.id)!));
    assert.ok(rendered.ownLines.every(line => rendered.messages.get(line) === next.id));
    assert.equal(rendered.mentionLines.length, 0); assert.equal(rendered.replyLines.length, 0);
    assert.ok(rendered.text.includes('第一行') && rendered.text.includes('第二行'));
    const image = rendered.images.find(s => s.messageId === reply.id)!;
    assert.equal(lines[image.line].slice(image.start, image.end), '[图片]');
    assert.equal(lines.filter(line => line === codeStyle(language).comment + ' 已撤回').length, 2);
  }
});
