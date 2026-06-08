import * as crypto from 'crypto';

const JWT_SECRET = process.env.JWT_SECRET || 'ncc-bot-interview-english-secret-key-123456';

function base64urlEncode(str: string | Buffer): string {
  const base64 = typeof str === 'string' ? Buffer.from(str).toString('base64') : str.toString('base64');
  return base64.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64urlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64').toString();
}

export function signJwt(payload: Record<string, any>, secret: string = JWT_SECRET): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const headerStr = base64urlEncode(JSON.stringify(header));
  const payloadStr = base64urlEncode(JSON.stringify(payload));
  const dataToSign = `${headerStr}.${payloadStr}`;
  const signature = crypto.createHmac('sha256', secret).update(dataToSign).digest();
  const signatureStr = base64urlEncode(signature);
  return `${dataToSign}.${signatureStr}`;
}

export function verifyJwt(token: string, secret: string = JWT_SECRET): Record<string, any> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerStr, payloadStr, signatureStr] = parts;
    const dataToSign = `${headerStr}.${payloadStr}`;
    const expectedSignature = crypto.createHmac('sha256', secret).update(dataToSign).digest();
    const expectedSignatureStr = base64urlEncode(expectedSignature);
    if (signatureStr !== expectedSignatureStr) return null;
    const payload = JSON.parse(base64urlDecode(payloadStr));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return null; // Expired
    }
    return payload;
  } catch {
    return null;
  }
}
