import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DraftService } from '../src/draftService';
import { boundReplies, outgoingReply, restoreReply } from '../src/replies';
import { ChatStore } from '../src/store';
import { newChat } from '../src/model';
import { OutboxService } from '../src/outbox';
import { OneBotClient } from '../src/onebot';
import { AccountSession } from '../src/accountSession';
import { MockNapCat } from './fixture';

test('回复占位符可删除、撤销恢复；替换回复只保留一个，重名仍绑定原消息 ID', () => {
  const drafts = new DraftService(() => {}), key = 'group:20001';
  drafts.setDraft(key, '保留正文');
  const first = drafts.setReply(key, '10', '成员');
  assert.equal(first.text, '[回复:成员]保留正文');
  const second = drafts.setReply(key, '-11', '成员');
  assert.equal(second.replyId, '-11'); assert.equal(boundReplies(second.text, second.replies).length, 1);
  assert.ok(second.text.includes('(-11)'));
  drafts.editDraft(key, '保留正文');
  assert.equal(drafts.draft(key).replyId, undefined);
  drafts.editDraft(key, second.text);
  assert.equal(drafts.draft(key).replyId, '-11');
  const send = outgoingReply(drafts.draft(key));
  assert.equal(send.replyId, '-11'); assert.equal(send.text, '保留正文');
  drafts.cancelReply(key); assert.equal(drafts.draft(key).text, '保留正文');
  assert.equal(drafts.draft(key).replyId, undefined);
  drafts.editDraft(key, '[回复:没有绑定]正文');
  assert.equal(drafts.draft(key).replyId, undefined);
  assert.equal(outgoingReply(drafts.draft(key)).text, '[回复:没有绑定]正文');
});

test('回复草稿迁移和恢复不保留已删除的引用，发送快照不受新的回复影响', () => {
  const migrated = restoreReply({ text: '旧正文', version: 2, attachments: [], replyId: '123' });
  assert.equal(migrated.text, '[回复:消息 123]旧正文');
  assert.equal(outgoingReply(migrated).text, '旧正文');
  assert.equal(restoreReply({ ...migrated, text: '已删除标记' }).replyId, undefined);
  const drafts = new DraftService(() => {}); drafts.setDraft('group:1', '正文');
  const first = drafts.setReply('group:1', '1', '甲');
  const second = drafts.setReply('group:1', '2', '乙');
  assert.equal(outgoingReply(first).replyId, '1'); assert.equal(outgoingReply(second).replyId, '2');
  assert.throws(() => outgoingReply({ ...second, text: first.replyPlaceholder! + second.text }), /只能回复一条/);
});

test('发送时回复标记转真实 reply 段，删除后不再回复，单独标记不能发送空消息', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-reply-'));
  const store = new ChatStore(folder, '123456'), backend = new MockNapCat(), client = new OneBotClient();
  await backend.start(); await client.connect(backend.url); store.upsert(newChat('group', 20001, '群'));
  const outbox = new OutboxService({ store, client, session: new AccountSession(), ready: true, log: () => {} });
  try {
    store.setDraft('group:20001', '正文'); store.setReply('group:20001', '123', '甲');
    assert.equal(await outbox.submit(store, 'group:20001', store.draft('group:20001').text, '123').completion, true);
    assert.deepEqual(backend.sent.at(-1).message, [{ type: 'reply', data: { id: '123' } }, { type: 'text', data: { text: '正文' } }]);
    store.setDraft('group:20001', '取消后正文'); store.setReply('group:20001', '123', '甲');
    store.editDraft('group:20001', '取消后正文');
    assert.equal(await outbox.submit(store, 'group:20001', store.draft('group:20001').text).completion, true);
    assert.deepEqual(backend.sent.at(-1).message, [{ type: 'text', data: { text: '取消后正文' } }]);
    store.setReply('group:20001', '123', '甲');
    assert.throws(() => outbox.submit(store, 'group:20001', store.draft('group:20001').text, '123'), /请输入|请在回复/);
    assert.equal(store.draft('group:20001').replyId, '123');
    await store.flush();
    const restored = new ChatStore(folder, '123456'); await restored.restore();
    assert.equal(restored.draft('group:20001').replyPlaceholder, '[回复:甲]');
    await restored.dispose();
  } finally { client.dispose(); await backend.close(); await store.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});
