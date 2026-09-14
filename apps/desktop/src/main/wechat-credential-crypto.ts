/**
 * wechat-credential-crypto.ts — botToken 落盘加密（纯逻辑 + safeStorage 适配）
 *
 * 历史问题：凭证文件只靠 chmod 0600 保护，Windows 上 chmod 无效 → botToken 明文落盘。
 * 改为 Electron safeStorage（主进程 OS 钥匙串）加密，密文带 enc:v1: 前缀；
 * 读到无前缀的旧明文时由调用方触发一次性迁移（覆写密文）。
 * 本文件不 import electron，加密能力以 TokenCipher 接口注入，保证纯 Node 可单测。
 */

export const ENC_PREFIX = 'enc:v1:';

export interface TokenCipher {
  available(): boolean;
  /** 明文 → base64 密文（不含前缀） */
  encrypt(plain: string): string;
  /** base64 密文 → 明文；解密失败（换机器/损坏）返回空串，调用方按未登录处理 */
  decrypt(encoded: string): string;
}

/** safeStorage → TokenCipher 适配（调用方注入 electron 的 safeStorage 对象） */
export function createSafeStorageCipher(safe: {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(buf: Buffer): string;
}): TokenCipher {
  return {
    available: () => {
      try { return safe.isEncryptionAvailable(); } catch { return false; }
    },
    encrypt: (plain) => safe.encryptString(plain).toString('base64'),
    decrypt: (encoded) => {
      try { return safe.decryptString(Buffer.from(encoded, 'base64')); } catch { return ''; }
    },
  };
}

/** 落盘编码：加密可用则密文；环境不支持（如无 keyring 的 Linux）降级明文 */
export function encodeToken(cipher: TokenCipher, plain: string): string {
  if (!plain || !cipher.available()) return plain;
  try {
    return ENC_PREFIX + cipher.encrypt(plain);
  } catch {
    return plain;
  }
}

/** 读盘解码：无前缀 = 旧明文原样返回（needsMigration 会触发覆写）；解密失败返回空串 */
export function decodeToken(cipher: TokenCipher, stored: string): string {
  if (!stored) return '';
  if (!stored.startsWith(ENC_PREFIX)) return stored;
  return cipher.decrypt(stored.slice(ENC_PREFIX.length));
}

/** 是否需要一次性迁移：有 token 但不是密文格式 */
export function needsMigration(stored: string): boolean {
  return !!stored && !stored.startsWith(ENC_PREFIX);
}
