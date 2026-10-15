import { renderTranscript } from '../src/transcriptRenderer';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { OneBotClient } from '../src/onebot';
import { chatKey, newChat, parseMessage } from '../src/model';
import { MediaCache } from '../src/media';
import { groupNotification } from '../src/notifications';

async function main(): Promise<void> {
  const configFile = process.argv[2];
  if (!configFile) throw new Error('需要指定 tuiqq config.json 路径');
  const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
  const client = new OneBotClient();
  const report: Record<string, unknown> = { readOnly: true, sends: 0 };
  let events = 0;
  client.on('event', event => { if (event.post_type === 'message' || event.post_type === 'message_sent') events++; });
  try {
    await client.connect(config.ws_url, config.ws_token ?? '');
    const login = await client.call('get_login_info');
    if (!login?.user_id) throw new Error('登录信息无效');
    report.login = 'ok';
    console.log('NapCat login: OK');
    const [friends, groups] = await Promise.all([client.call('get_friend_list'), client.call('get_group_list')]);
    report.friends = friends.length; report.groups = groups.length;
    console.log(`NapCat lists: ${friends.length} friends, ${groups.length} groups`);
    let favoriteUrls: string[] = [];
    try {
      const faces = await client.call('fetch_custom_face', { count: 48 });
      favoriteUrls = Array.isArray(faces) ? faces.filter((f: unknown) => typeof f === 'string') : [];
      report.favoriteFaces = { supported: true, count: Array.isArray(faces) ? faces.length : 0, format: Array.isArray(faces) && faces.length ? typeof faces[0] : 'empty' };
      console.log('Favorite faces:', JSON.stringify(report.favoriteFaces));
    } catch { report.favoriteFaces = { supported: false }; }
    const histories: { kind: string; messages: number; images: number }[] = [];
    const imageRefs = [];
    let recent: any[] = [];
    try { const data = await client.call('get_recent_contact', { count: 20 }); recent = Array.isArray(data) ? data : data?.list ?? []; } catch {}
    const recentIds = recent.map(c => String(c.lastestMsg?.group_id ?? c.group_id ?? c.peerUin ?? c.peer_uin ?? ''));
    const sortedGroups = [...groups].sort((a, b) => {
      const ai = recentIds.indexOf(String(a.group_id)), bi = recentIds.indexOf(String(b.group_id));
      return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
    });
    const masks: Record<string, number> = {};
    for (const group of sortedGroups.slice(0, 8)) {
      try {
        const detail = await client.call('get_group_detail_info', { group_id: String(group.group_id) });
        const mode = groupNotification(detail); masks[mode] = (masks[mode] ?? 0) + 1;
      } catch { masks.errors = (masks.errors ?? 0) + 1; }
    }
    report.notifications = { groups: masks, friendDndFields: Object.keys(friends[0] ?? {}).filter(k => /mask|mute|notify|disturb/i.test(k)) };
    console.log('Notification API:', JSON.stringify(report.notifications));
    let historyErrors = 0;
    for (const group of sortedGroups.slice(0, 8)) {
      let data: any;
      try { data = await client.call('get_group_msg_history', { group_id: group.group_id, count: 30 }); }
      catch { historyErrors++; continue; }
      const chat = newChat('group', group.group_id, '验证会话');
      const messages = (data?.messages ?? []).map((raw: unknown) => parseMessage(raw, chat.key, String(login.user_id)));
      const rendered = renderTranscript(chat, messages, String(login.user_id));
      histories.push({ kind: 'group', messages: messages.length, images: rendered.images.length });
      for (const msg of messages) for (const segment of msg.segments) if (segment.type === 'image') imageRefs.push(segment.image);
      if (histories.length >= 3) break;
    }
    if (friends.length) {
      const recentPrivate = recent.map(c => c.lastestMsg).find(c => c?.message_type === 'private');
      const friendId = recentPrivate ? (String(recentPrivate.user_id) === String(login.user_id) ? recentPrivate.target_id : recentPrivate.user_id) : friends[0].user_id;
      try {
        const data = await client.call('get_friend_msg_history', { user_id: friendId, count: 10 });
        const messages = (data?.messages ?? []).map((raw: unknown) => parseMessage(raw, chatKey('private', friendId), String(login.user_id)));
        histories.push({ kind: 'private', messages: messages.length, images: 0 });
      } catch { historyErrors++; }
    }
    report.histories = histories;
    report.historyErrors = historyErrors;
    if (imageRefs.length || favoriteUrls.length) {
      const folder = path.resolve('.test-output', 'live-images');
      const cache = new MediaCache(folder, client);
      let ok = 0;
      for (const ref of imageRefs.slice(0, 3)) { try { await cache.get(ref); ok++; } catch {} }
      report.images = { attempted: Math.min(3, imageRefs.length), downloaded: ok };
      if (favoriteUrls.length) {
        try { await cache.get({ file: '', url: favoriteUrls[0] }); report.favoritePreview = 'downloaded'; }
        catch { report.favoritePreview = 'failed'; }
      }
      await fs.rm(folder, { recursive: true, force: true });
    }
    report.receivedEvents = events;
    await fs.mkdir('.test-output', { recursive: true });
    await fs.writeFile('.test-output/live-result.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { client.dispose(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
