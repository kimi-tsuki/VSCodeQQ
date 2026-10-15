import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import type { QQApp } from '../src/extension';
import { MockNapCat, until } from './fixture';
import { TestUI } from './ui';

export async function testEmojiShortcuts(app: QQApp, backend: MockNapCat, ui: TestUI, checks: string[]): Promise<void> {
  await app.openChat('group:20002');
  const editor = vscode.window.activeTextEditor!, key = 'group:20002';
  await app.emojis.inlineEntries();
  const before = backend.sent.length;
  for (const trigger of ['!', '！']) {
    app.store!.setDraft(key, '左边右边', undefined, []);
    await until(() => app.native.draft(editor.document) === '左边右边' && !app.native.isUpdating(editor.document));
    const position = editor.document.positionAt(app.native.region(editor.document)!.start + 2);
    editor.selection = new vscode.Selection(position, position);
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await ui.call('Input.insertText', { text: trigger });
    await until(() => app.native.draft(editor.document) === '左边' + trigger + '右边');
    await ui.waitFor(`!!document.querySelector('.suggest-widget.visible')`);
    const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', editor.document.uri, editor.selection.active, trigger, 20);
    const images = list.items.filter(item => typeof item.label !== 'string' && item.label.description === '收藏表情');
    assert.ok(images.length >= 2, '应显示收藏表情候选');
    assert.ok(list.items.some(item => typeof item.label !== 'string' && item.label.description?.startsWith('最近使用')));
    assert.ok(images.some(item => typeof item.documentation !== 'string' && item.documentation?.value.includes('<img')), '收藏表情应通过本地缓存生成图片详情');
    // Filter to a favorite, then accept through the real suggestion widget.
    await ui.call('Input.insertText', { text: '收藏表情1' });
    await ui.waitFor(`document.querySelector('.suggest-widget.visible')?.textContent.includes('收藏表情 1')`);
    await ui.enter();
    await until(() => /^左边\[图片:\d+\]右边$/.test(app.native.draft(editor.document)) && !app.emojis.isImporting(key));
    assert.equal(app.store!.draft(key).attachments.at(-1)?.sticker, true);
    assert.equal(backend.sent.length, before, '快捷选择表情不能自动发送');
    assert.equal((app.emojis as any).view?.visible ?? false, false, '不应打开底部表情面板');
    app.store!.setDraft(key, '', undefined, []);
    await until(() => app.native.draft(editor.document) === '' && !app.native.isUpdating(editor.document));
  }
  app.store!.setDraft(key, '！', undefined, []);
  await until(() => app.native.draft(editor.document) === '！' && !app.native.isUpdating(editor.document));
  const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', editor.document.uri, editor.document.positionAt(editor.document.getText().length), '！');
  const args = list.items.find(item => item.command?.command === 'qq.insertInlineEmoji')!.command!.arguments!;
  await assert.rejects(app.emojiCompletion.insert(args[0], { ...args[1], generation: -1 }), /会话或连接/);
  assert.equal(app.native.draft(editor.document), '！');
  app.store!.setDraft(key, '', undefined, []);
  checks.push('半角 ! / 全角 ！真实触发原生表情补全，最近优先、图片详情、光标处插入占位符、不打开面板、不自动发送');
}
