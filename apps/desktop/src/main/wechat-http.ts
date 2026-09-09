/**
 * wechat-http.ts — iLink 协议 HTTP 客户端
 *
 * 轻量 HTTPS POST/GET 客户端，携带 iLink 协议所需的请求头。
 */
import crypto from 'node:crypto';
import https from 'node:https';

const ILINK_BASE = 'https://ilinkai.weixin.qq.com';
const ILINK_APP_ID = 'bot';
const ILINK_APP_CLIENT_VERSION = 0x00020008; // 2.0.8

/** 构建通用请求头 */
function buildCommonHeaders(): Record<string, string> {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
  };
}

/** 构建 POST 请求头 */
function buildPostHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    ...buildCommonHeaders(),
  };
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

/** X-WECHAT-UIN header: random uint32 → decimal string → base64 */
function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

/**
 * HTTPS POST 请求
 */
export function httpsPost(path: string, body: string, token?: string, timeoutMs = 15000): Promise<string> {
  const url = new URL(path, ILINK_BASE);
  const headers = buildPostHeaders(token);
  headers['Content-Length'] = String(Buffer.byteLength(body));

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'POST',
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`iLink POST ${path} HTTP ${res.statusCode}: ${data}`));
            return;
          }
          resolve(data);
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`iLink POST ${path} timeout`)); });
    req.write(body);
    req.end();
  });
}

/**
 * HTTPS GET 请求
 */
export function httpsGet(path: string, timeoutMs = 35000): Promise<string> {
  const url = new URL(path, ILINK_BASE);
  const headers = buildCommonHeaders();

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'GET',
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 500) {
            reject(new Error(`iLink GET ${path} HTTP ${res.statusCode}`));
            return;
          }
          resolve(data);
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`iLink GET ${path} timeout`)); });
    req.end();
  });
}

/** 默认 base URL */
export const ILINK_DEFAULT_BASE = ILINK_BASE;
