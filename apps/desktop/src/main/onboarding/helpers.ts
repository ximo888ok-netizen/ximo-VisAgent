/**
 * onboarding/helpers.ts — 辅助函数
 */
import { createHash } from 'node:crypto';
import type { RawFactCard } from './types';

/** md5 哈希取前 16 位，用于分块去重 */
export function hashStr(s: string): string {
  return createHash('md5').update(s).digest('hex').slice(0, 16);
}

/** 按主题分组事实卡 */
export function groupByTopic(cards: RawFactCard[]): { topic: string; count: number; summary: string }[] {
  const map = new Map<string, RawFactCard[]>();
  for (const c of cards) {
    const arr = map.get(c.topic) ?? [];
    arr.push(c);
    map.set(c.topic, arr);
  }
  return Array.from(map.entries()).map(([topic, items]) => ({
    topic,
    count: items.length,
    summary: items.map((c) => c.claim).slice(0, 3).join('; '),
  }));
}
