import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { verifyJwt } from './jwt.util';

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach((item) => {
    const parts = item.split('=');
    const name = parts[0].trim();
    if (name) {
      cookies[name] = parts.slice(1).join('=').trim();
    }
  });
  return cookies;
}

@Injectable()
export class AdminAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const cookies = parseCookies(request.headers.cookie);
    const token = cookies['accessToken'];

    if (!token) {
      throw new UnauthorizedException('Missing access token');
    }

    const payload = verifyJwt(token);
    if (!payload) {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    // Attach stateless admin context to request
    request.admin = {
      id: payload.sub,
      username: payload.username,
    };

    return true;
  }
}
