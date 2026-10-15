export interface QQRequest {
  key: string; type: 'friend' | 'group'; flag: string; userId: string;
  groupId?: string; subType?: 'add' | 'invite'; comment: string;
}
// Request flags belong to an account. Do not persist them or reuse them after switching accounts.
export class RequestInbox {
  private account = '';
  private values = new Map<string, QQRequest>();
  entries(account: string): QQRequest[] { return account === this.account ? [...this.values.values()] : []; }
  add(event: any, account: string): void {
    if (event?.post_type !== 'request' || String(event.self_id ?? account) !== account) return;
    if (!['friend', 'group'].includes(event.request_type) || !['string', 'number'].includes(typeof event.flag) || !String(event.flag) || !/^[1-9]\d*$/.test(String(event.user_id))) return;
    if (event.request_type === 'group' && (!['add', 'invite'].includes(event.sub_type) || !/^[1-9]\d*$/.test(String(event.group_id)))) return;
    if (this.account !== account) { this.clear(); this.account = account; }
    const key = `${event.request_type}:${event.sub_type ?? ''}:${event.group_id ?? ''}:${event.flag}`;
    this.values.set(key, { key, type: event.request_type, flag: String(event.flag), userId: String(event.user_id), groupId: event.group_id ? String(event.group_id) : undefined, subType: event.sub_type, comment: String(event.comment ?? '').slice(0, 2000) });
    if (this.values.size > 100) this.values.delete(this.values.keys().next().value!);
  }
  remove(account: string, key: string): void { if (account === this.account) this.values.delete(key); }
  clear(): void { this.values.clear(); this.account = ''; }
}
