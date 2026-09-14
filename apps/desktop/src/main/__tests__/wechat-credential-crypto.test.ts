/**
 * wechat-credential-crypto.test.ts — botToken 落盘加密与明文迁移的门禁
 *
 * 背景：chmod 0600 在 Windows 无效，botToken 曾明文躺在 userData。
 * 这里钉住 编码→解码 往返、旧明文识别（迁移触发）与解密失败按未登录处理。
 */
import { describe, it, expect } from 'vitest';
import {
  ENC_PREFIX,
  createSafeStorageCipher,
  encodeToken,
  decodeToken,
  needsMigration,
  type TokenCipher,
} from '../wechat-credential-crypto';

const fakeCipher = (available: boolean): TokenCipher => ({
  available: () => available,
  encrypt: (plain) => Buffer.from(plain, 'utf8').toString('base64'),
  decrypt: (encoded) => {
    try {
      return Buffer.from(encoded, 'base64').toString('utf8');
    } catch {
      return '';
    }
  },
});

describe('encodeToken / decodeToken', () => {
  it('加密可用时往返一致，落盘形态带 enc:v1: 前缀', () => {
    const cipher = fakeCipher(true);
    const stored = encodeToken(cipher, 'bot-token-123');
    expect(stored.startsWith(ENC_PREFIX)).toBe(true);
    expect(stored).not.toContain('bot-token-123');
    expect(decodeToken(cipher, stored)).toBe('bot-token-123');
  });

  it('环境不支持加密时降级明文（与原行为一致，不静默丢 token）', () => {
    const cipher = fakeCipher(false);
    expect(encodeToken(cipher, 'tok')).toBe('tok');
    expect(needsMigration('tok')).toBe(true);
  });

  it('旧明文直接读出，needsMigration 触发一次性覆写', () => {
    const cipher = fakeCipher(true);
    expect(needsMigration('legacy-plain-token')).toBe(true);
    expect(needsMigration(ENC_PREFIX + 'eA==')).toBe(false);
    expect(needsMigration('')).toBe(false);
    expect(decodeToken(cipher, 'legacy-plain-token')).toBe('legacy-plain-token');
  });

  it('密文解密失败 → 空串（调用方按未登录重新扫码）', () => {
    const broken: TokenCipher = { ...fakeCipher(true), decrypt: () => '' };
    expect(decodeToken(broken, ENC_PREFIX + 'xxxx')).toBe('');
  });
});

describe('createSafeStorageCipher', () => {
  it('safeStorage 抛异常时 available 收敛为 false，不阻塞启动', () => {
    const cipher = createSafeStorageCipher({
      isEncryptionAvailable: () => { throw new Error('before app ready'); },
      encryptString: (s) => Buffer.from(s, 'utf8'),
      decryptString: (b) => b.toString('utf8'),
    });
    expect(cipher.available()).toBe(false);
  });

  it('适配器与 safeStorage 语义对接（encrypt→base64→decrypt 往返）', () => {
    const cipher = createSafeStorageCipher({
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(`enc<${s}>`, 'utf8'),
      decryptString: (b) => {
        const text = b.toString('utf8');
        return text.startsWith('enc<') && text.endsWith('>') ? text.slice(4, -1) : '';
      },
    });
    const stored = encodeToken(cipher, 'token-abc');
    expect(decodeToken(cipher, stored)).toBe('token-abc');
  });
});
