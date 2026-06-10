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

    return {
      success: true,
      username: admin.username,
      accessToken,
      refreshToken,
    };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body('refreshToken') refreshToken: string,
  ) {
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

    return {
      success: true,
      accessToken,
    };
  }

  @Post('logout')
  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() req: any,
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

    return { success: true };
  }
}
