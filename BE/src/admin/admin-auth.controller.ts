import { Controller, Post, Body, HttpCode, HttpStatus, UnauthorizedException, UseGuards, Req, Res } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Response, Request } from 'express';
import { Admin } from '@/database-test/entities/admin.entity';
import { AdminAuthGuard } from './admin-auth.guard';
import { signJwt } from './jwt.util';
import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'crypto';

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

@Controller('admin/auth')
export class AdminAuthController {
  constructor(
    @InjectRepository(Admin)
    private readonly adminRepo: Repository<Admin>,
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: Record<string, any>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { username, password } = body;

    if (!username || !password) {
      throw new UnauthorizedException('Username and password are required');
    }

    const admin = await this.adminRepo.findOne({
      where: { username },
    });

    if (!admin) {
      throw new UnauthorizedException('Invalid username or password');
    }

    const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
    if (admin.passwordHash !== passwordHash) {
      throw new UnauthorizedException('Invalid username or password');
    }

    // Sign stateless JWT access token (15 mins)
    const exp = Math.floor(Date.now() / 1000) + 15 * 60;
    const accessToken = signJwt({ sub: admin.id, username: admin.username, exp });

    // Generate random UUID refresh token (7 days)
    const refreshToken = uuidv4();
    const refreshTokenExpiresAt = new Date();
    refreshTokenExpiresAt.setDate(refreshTokenExpiresAt.getDate() + 7);

    admin.refreshToken = refreshToken;
    admin.refreshTokenExpiresAt = refreshTokenExpiresAt;
    await this.adminRepo.save(admin);

    // Set secure HttpOnly cookies
    res.setHeader('Set-Cookie', [
      `accessToken=${accessToken}; Path=/; HttpOnly; Max-Age=${15 * 60}; SameSite=Lax`,
      `refreshToken=${refreshToken}; Path=/; HttpOnly; Max-Age=${7 * 24 * 60 * 60}; SameSite=Lax`,
    ]);

    return {
      success: true,
      username: admin.username,
    };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const cookies = parseCookies(req.headers.cookie);
    const refreshToken = cookies['refreshToken'];

    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token is missing');
    }

    const admin = await this.adminRepo.findOne({
      where: { refreshToken },
    });

    if (!admin) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (admin.refreshTokenExpiresAt && admin.refreshTokenExpiresAt < new Date()) {
      // Refresh token expired, clear it
      admin.refreshToken = null;
      admin.refreshTokenExpiresAt = null;
      await this.adminRepo.save(admin);
      throw new UnauthorizedException('Refresh token has expired');
    }

    // Generate new stateless JWT access token (15 mins)
    const exp = Math.floor(Date.now() / 1000) + 15 * 60;
    const accessToken = signJwt({ sub: admin.id, username: admin.username, exp });

    res.setHeader('Set-Cookie', [
      `accessToken=${accessToken}; Path=/; HttpOnly; Max-Age=${15 * 60}; SameSite=Lax`,
    ]);

    return {
      success: true,
    };
  }

  @Post('logout')
  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
  ) {
    const adminContext = req.admin;
    if (adminContext && adminContext.id) {
      const admin = await this.adminRepo.findOne({ where: { id: adminContext.id } });
      if (admin) {
        admin.refreshToken = null;
        admin.refreshTokenExpiresAt = null;
        await this.adminRepo.save(admin);
      }
    }

    // Clear secure HttpOnly cookies
    res.setHeader('Set-Cookie', [
      `accessToken=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax`,
      `refreshToken=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax`,
    ]);

    return { success: true };
  }
}
