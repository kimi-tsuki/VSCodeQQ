import { codeLanguages } from './codeStyle';
export const languageLabels = { c: 'C', python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript', dart: 'Dart', kotlin: 'Kotlin', java: 'Java', swift: 'Swift' } as const;
export const chatSettings = {
  codeLanguage: { type: 'string', default: 'c', enum: [...codeLanguages] },
  historyCount: { type: 'number', default: 50, minimum: 10, maximum: 500 },
  messageLimit: { type: 'number', default: 500, minimum: 50, maximum: 2000 },
  notifications: { type: 'string', default: 'all', enum: ['all', 'mentions', 'off'] },
  cacheRetentionDays: { type: 'number', default: 7, minimum: 1, maximum: 90 },
  mentionColor: { type: 'string', default: '#E5A030', pattern: '^#[0-9a-fA-F]{6}$' },
  replyColor: { type: 'string', default: '#409CFF', pattern: '^#[0-9a-fA-F]{6}$' }
} as const;
export type ChatSetting = keyof typeof chatSettings;
export function validateChatSettings(input: Record<string, unknown>): [ChatSetting, unknown][] {
  const updates: [ChatSetting, unknown][] = [];
  for (const key of Object.keys(chatSettings) as ChatSetting[]) {
    const value = input[key], definition = chatSettings[key];
    if (value === undefined) continue;
    if ('minimum' in definition) {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < definition.minimum || value > definition.maximum) throw new Error(`${key} 必须为 ${definition.minimum}～${definition.maximum} 的整数`);
    } else if ('enum' in definition) {
      if (!(definition.enum as readonly unknown[]).includes(value)) throw new Error(`${key} 选项无效`);
    } else if (typeof value !== 'string' || !new RegExp(definition.pattern).test(value)) throw new Error('高亮颜色格式无效');
    updates.push([key, value]);
  }
  return updates;
}
