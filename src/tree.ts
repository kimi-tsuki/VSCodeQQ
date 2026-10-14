import * as vscode from 'vscode';
import { Chat } from './model';
import { ChatStore } from './store';
import { allowsUnread } from './notifications';
export type Section = 'list' | 'favorites';
export class ChatTree implements vscode.TreeDataProvider<Chat>, vscode.Disposable {
  private emitter = new vscode.EventEmitter<Chat | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private timer?: NodeJS.Timeout;
  filter = '';
  setFilter(value: string): void { this.filter = value.trim(); this.refresh(); }
  constructor(readonly section: Section, private getStore: () => ChatStore | undefined) {}
  refresh(): void {
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.emitter.fire(undefined); }, 150);
  }
  getChildren(): Chat[] {
    const store = this.getStore(); if (!store) return [];
    const terms = this.filter.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return [...store.chats.values()].filter(chat => {
      if (!terms.every(term => `${chat.name} ${chat.id}`.toLocaleLowerCase().includes(term))) return false;
      switch (this.section) {
        case 'favorites': return store.favorites.has(chat.key);
        case 'list': return true;
      }
    }).sort((a,b) => Number(b.unread > 0 && allowsUnread(b)) - Number(a.unread > 0 && allowsUnread(a)) || b.lastTime - a.lastTime || a.name.localeCompare(b.name, 'zh-CN'));
  }
  getTreeItem(chat: Chat): vscode.TreeItem {
    const node = new vscode.TreeItem(chat.name);
    node.id = `${this.section}:${chat.key}`; node.contextValue = 'qq-chat';
    const mode = chat.ignoreUnread ? '已忽略未读' : chat.type === 'private' ? '好友免打扰未同步；可右键忽略未读' : chat.notification === 'muted' ? 'QQ 免打扰' : chat.notification === 'notify' ? 'QQ 接收并提醒' : '免打扰状态未知，暂不列入未读';
    const allowed = allowsUnread(chat);
    node.description = `${!allowed ? '◦ ' : ''}${chat.mentioned ? '@我 ' : ''}${chat.replied ? '回复我 ' : ''}${allowed && chat.unread ? `(${chat.unread}) ` : ''}${chat.preview}`.trim();
    node.tooltip = `${chat.name}\n${chat.type === 'group' ? '群号' : 'QQ'}：${chat.id}\n${mode}${chat.preview ? `\n${chat.preview}` : ''}`;
    node.iconPath = new vscode.ThemeIcon(this.getStore()?.favorites.has(chat.key) ? 'star-full' : chat.type === 'group' ? 'organization' : 'account');
    node.command = { command: 'qq.openChat', title: '打开会话', arguments: [chat.key] };
    return node;
  }
  dispose(): void { clearTimeout(this.timer); this.emitter.dispose(); }
}
