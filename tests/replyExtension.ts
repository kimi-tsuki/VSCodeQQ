import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import type { QQApp } from '../src/extension';
import { MockNapCat, until } from './fixture';

export async function testReplyPlaceholder(app: QQApp, backend: MockNapCat, checks: string[]): Promise<void> {
  await app.openChat('group:20002');
  const editor = vscode.window.activeTextEditor!, key = 'group:20002';
  app.store!.setDraft(key, '保留回复正文', undefined, []);
  await until(() => app.native.draft(editor.document) === '保留回复正文' && !app.native.isUpdating(editor.document));
  await vscode.commands.executeCommand('qq.reply', editor.document.uri.toString(), '77990');
  const selected = app.store!.draft(key), token = selected.replyPlaceholder!;
  assert.ok(selected.text.startsWith(token)); assert.equal(selected.replyId, '77990');
  assert.ok(!editor.document.getText().includes('reply_to('));
  const region = app.native.region(editor.document)!;
  const hover = await app.native.hover(editor.document, editor.document.positionAt(region.start + 2));
  assert.ok(hover?.contents.some(content => content instanceof vscode.MarkdownString && content.value.includes('click-body-probe')));
  const history = editor.document.getText().slice(0, region.start);
  await editor.edit(edit => edit.delete(new vscode.Range(editor.document.positionAt(region.start), editor.document.positionAt(region.start + token.length))));
  await until(() => app.store!.draft(key).replyId === undefined && !app.native.isUpdating(editor.document));
  assert.equal(app.native.draft(editor.document), '保留回复正文');
  assert.equal(editor.document.getText().slice(0, app.native.region(editor.document)!.start), history);
  await vscode.commands.executeCommand('undo');
  await until(() => app.store!.draft(key).replyId === '77990' && !app.native.isUpdating(editor.document));
  assert.equal(app.native.draft(editor.document), token + '保留回复正文');
  await vscode.commands.executeCommand('qq.reply', editor.document.uri.toString(), '77702');
  assert.equal(app.store!.draft(key).replyId, '77702');
  assert.equal((app.native.draft(editor.document).match(/\[回复:/g) ?? []).length, 1);
  await vscode.commands.executeCommand('qq.cancelReply');
  assert.equal(app.store!.draft(key).replyId, undefined);
  assert.equal(app.native.draft(editor.document), '保留回复正文');
  app.store!.setDraft(key, '', undefined, []);
  checks.push('回复以草稿内占位符呈现，悬浮原文、直接删除取消、撤销恢复绑定、重新选择替换且不改动历史');
}
