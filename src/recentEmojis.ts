export interface RecentEmoji {
  id: string;
  kind: 'face' | 'image';
  label: string;
  faceId?: string;
  file?: string;
}
export function rememberEmoji(items: RecentEmoji[], item: RecentEmoji): RecentEmoji[] {
  return [item, ...items.filter(previous => previous.id !== item.id)].slice(0, 10);
}
