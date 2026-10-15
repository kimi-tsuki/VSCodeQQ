import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { QQApp } from '../src/extension';
import { newChat, parseMessage } from '../src/model';
import { MockNapCat, png, until } from './fixture';
import { TestUI } from './ui';

// Real extension UI with synthetic data; no real QQ account or message sending.
export async function run(): Promise<void> {
  const backend = new MockNapCat();
  backend.history = () => [];
  await backend.start();
  let app: QQApp | undefined, ui: TestUI | undefined;
  try {
    const extension = vscode.extensions.getExtension<{ app: QQApp }>('rynxis.vscode-qq')!;
    app = (await extension.activate()).app;
    await vscode.workspace.getConfiguration('editor').update('editContext', false, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('qq').update('notifications', 'off', vscode.ConfigurationTarget.Global);
    await app.config.saveConnection(backend.url, '', false);
    await app.connect();
    await until(() => app!.ready && backend.listResponses >= 2);
    ui = await TestUI.connect();
    await ui.call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('workbench.action.joinAllGroups');
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await vscode.commands.executeCommand('workbench.action.closePanel');
    await vscode.commands.executeCommand('qq.show.list');

    const store = app.store!, key = 'group:30001';
    store.chats.delete('group:20001');
    store.upsert(newChat('group', 30001, 'NapCat · 插件开发'));
    store.upsert(newChat('group', 20002, '周末摄影群'));
    store.upsert({ ...newChat('private', 10001, '林同学'), remark: '林同学' });
    for (const chat of [newChat('group', 20003, '项目讨论'), newChat('private', 10002, '阿宁'), newChat('group', 20004, '技术交流'), newChat('private', 10003, '小周')]) store.upsert(chat);
    store.toggleFavorite(key);
    store.setNotification('group:20002', 'muted');
    store.chats.get('group:20002')!.unread = 12;
    store.chats.get('group:20002')!.preview = '周末去哪里拍照？';
    store.setNotification('group:20003', 'notify');
    store.chats.get('group:20003')!.unread = 3;
    store.chats.get('group:20003')!.preview = '新的设计稿已经上传';
    store.setNotification('group:20004', 'muted');
    store.chats.get('group:20004')!.unread = 8;
    store.toggleCollapsed('group:20004');
    store.chats.get('private:10002')!.preview = '好的，晚点见。';
    store.chats.get('private:10003')!.preview = '安装包收到了';
    await app.openChat(key);
    await app.loadMembers(key);
    store.setMembers(key, [
      { user_id: 123456, card: '我', role: 'member' },
      { user_id: 10001, card: '小林', title: '协作者', role: 'member' },
      { user_id: 10002, card: '阿宁', title: '开发组', role: 'admin' },
      { user_id: 10003, card: '小周', role: 'member' }
    ]);
    const base = new Date('2026-10-15T09:41:00+08:00').getTime() / 1000;
    const samples = [
      { message_id: 7001, user_id: 123456, message: [{ type: 'text', data: { text: '0.2.8 已打包，安装后重新加载窗口即可。' } }] },
      { message_id: 7002, user_id: 10002, message: [{ type: 'reply', data: { id: 7001 } }, { type: 'text', data: { text: '我这边验证通过，回复和图片预览都正常。' } }] },
      { message_id: 7003, user_id: 10001, message: [{ type: 'at', data: { qq: 123456 } }, { type: 'text', data: { text: ' 发布后记得更新 README，截图也一起换新。' } }, { type: 'image', data: { file: 'preview.png', url: backend.imageUrl } }] },
      { message_id: 7004, user_id: 10003, message: [{ type: 'text', data: { text: '这一条是重复发送的。' } }] }
    ];
    for (const [index, sample] of samples.entries()) store.add(parseMessage({ ...sample, time: base + index * 30, message_type: 'group', group_id: 30001, sender: { user_id: sample.user_id } }, key, store.selfId), false);
    store.recall(key, '7004');
    const mention = store.reserveMention(key, '10001', '小林');
    store.setDraft(key, `收到，${mention} 我再检查一次截图。`);
    store.setReply(key, '7002', '阿宁');
    store.attach(key, [await app.attachments!.stage(png, '截图示例')]);
    app.trees[0].refresh();
    const editor = vscode.window.activeTextEditor!;
    await app.native.sync(editor, true);
    await app.native.focus(editor);
    await vscode.commands.executeCommand('notifications.clearAll');
    const list = await ui.webview('body[data-section="list"] #search');
    await until(async () => await list.evaluate(`document.querySelectorAll('.row').length === 6`));
    await list.evaluate('document.fonts.ready');

    const output = path.join(extension.extensionPath, '.test-output', 'previews');
    await fs.mkdir(output, { recursive: true });
    const screenshots: Record<string, unknown>[] = [];
    const capture = async (name: string) => {
      await vscode.commands.executeCommand('notifications.clearAll');
      await ui!.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const layout = await ui!.evaluate(`(() => {const rect=id=>document.getElementById(id)?.getBoundingClientRect();return {width:innerWidth,height:innerHeight,auxiliaryWidth:rect('workbench.parts.auxiliarybar')?.width||0,editorWidth:rect('workbench.parts.editor')?.width||0};})()`);
      assert.equal(layout.width, 1600); assert.equal(layout.height, 1000);
      assert.equal(layout.auxiliaryWidth, 0, '截图不能包含右侧 Copilot 区域');
      assert.ok(layout.editorWidth >= 1000, '主编辑区必须保持足够宽度');
      assert.equal(vscode.window.tabGroups.all.length, 1, '预览使用单个编辑器组');
      const result = await ui!.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const bytes = Buffer.from(result.data, 'base64');
      assert.equal(bytes.readUInt32BE(16), 1600); assert.equal(bytes.readUInt32BE(20), 1000);
      await fs.writeFile(path.join(output, name), bytes);
      screenshots.push({ name, ...layout });
    };

    await capture('message-highlights.png');
    await vscode.commands.executeCommand('qq.configure');
    const settings = await ui.webview('#codeLanguage');
    await until(async () => await settings.evaluate(`document.getElementById('url').value.startsWith('ws://') && document.getElementById('codeLanguage').value === 'c'`));
    await settings.evaluate('document.fonts.ready');
    await capture('settings.png');
    await vscode.window.tabGroups.close(vscode.window.tabGroups.activeTabGroup.activeTab!);
    await app.openChat(key);
    await vscode.commands.executeCommand('qq.emojis');
    const panel = await ui.webview('#basicFaces');
    await until(async () => await panel.evaluate(`document.querySelectorAll('#basicFaces button').length > 0`));
    await panel.evaluate(`document.getElementById('tabBasic').click()`);
    const chatEditor = vscode.window.visibleTextEditors.find(e => e.document.uri.scheme === 'qqchat')!;
    app.editor.latest(chatEditor, false);
    await until(() => chatEditor.visibleRanges.some(range => range.end.line >= chatEditor.document.lineCount - 2));
    await capture('emoji-picker.png');
    await panel.key('Escape', 27);
    await until(() => vscode.window.activeTextEditor?.document.uri.scheme === 'qqchat');
    store.setDraft(key, '/', undefined, []);
    const active = vscode.window.activeTextEditor!;
    await app.native.sync(active, true); await app.native.focus(active);
    await vscode.commands.executeCommand('editor.action.triggerSuggest');
    await ui.waitFor(`document.querySelector('.suggest-widget.visible')?.textContent.includes('/emoji')`);
    await capture('slash-commands.png');
    await vscode.commands.executeCommand('hideSuggestWidget');
    assert.equal(backend.sent.length, 0);
    await fs.writeFile(path.join(output, 'preview-result.json'), JSON.stringify({ version: extension.packageJSON.version, screenshots, realSends: 0, simulatedSends: backend.sent.length }, null, 2));
    console.log(`QQ previews: ${screenshots.length} screenshots, 1600x1000, Copilot closed, no messages sent`);
  } finally { ui?.close(); await app?.shutdown(); await backend.close(); }
}
