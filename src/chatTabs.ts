import * as vscode from 'vscode';
import { ChatStore } from './store';
import { Transcript } from './transcript';
import { allowsUnread } from './notifications';

export class ChatTabs implements vscode.Disposable {
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private updating = false;
  private again = false;
  constructor(private host: { store?: ChatStore; transcript?: Transcript }, private log: (error: unknown) => void) {}
  refresh(): void {
    if (this.stopped) return;
    if (this.updating) { this.again = true; return; }
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.update(); }, 60);
  }
  private async update(): Promise<void> {
    this.updating = true;
    try {
      for (const group of vscode.window.tabGroups.all) for (const tab of group.tabs) {
        if (this.stopped || !(tab.input instanceof vscode.TabInputText)) continue;
        const uri = tab.input.uri, key = this.host.transcript?.key(uri), chat = key && this.host.store?.chats.get(key);
        if (!chat) continue;
        const marker = chat.unread && allowsUnread(chat) ? chat.mentioned ? '@ ' : chat.replied ? '↩ ' : '● ' : '';
        const label = marker + chat.name;
        if (tab.label === label || !group.tabs.includes(tab)) continue;
        // vscode.open supports a label for virtual text resources. Background
        // updates preserve the URI, document, draft, selections and active tab.
        await vscode.commands.executeCommand('vscode.open', uri, {
          viewColumn: group.viewColumn, preserveFocus: true, background: true, preview: tab.isPreview
        }, label);
      }
    } catch (error) { this.log(error); }
    finally { this.updating = false; if (this.again) { this.again = false; this.refresh(); } }
  }
  dispose(): void { this.stopped = true; clearTimeout(this.timer); }
}
