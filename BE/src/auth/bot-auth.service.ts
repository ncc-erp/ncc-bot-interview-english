import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";

@Injectable()
export class BotAuthService {
  private readonly logger = new Logger(BotAuthService.name);
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private expiresAt = 0;

  private refreshingPromise: Promise<void> | null = null;

  constructor(
    private readonly configService: ConfigService,
  ) {}

  async login() {
    this.logger.log("Bot login...");

    const baseUrl = this.configService.get<string>("AGENT_BASE_URL");
    const appid = this.configService.get<string>('MEZON_BOT_ID')!;
    const token = this.configService.get<string>('MEZON_TOKEN')!;

    try {
      const response = await axios.post(`${baseUrl}/api/v2/auth/mezon/bot/login`, {
        account: {
          appid: appid,
          token: token,
        },
      });
      this.setTokens(response.data);
      this.logger.log("✅ Bot login successful");
    } catch (error: any) {
      this.logger.error("Bot login failed", error.message);
    }
  }

  async refresh() {
    if (!this.refreshToken) {
      this.logger.error("No refresh token available, cannot refresh bot token");
      return;
    }

    this.logger.log("Refreshing bot token...");
    const baseUrl = this.configService.get<string>("AGENT_BASE_URL");
    try {
      const response = await axios.post(`${baseUrl}/api/v2/auth/refresh`, {
        refresh_token: this.refreshToken,
      });
      this.setTokens(response.data);
      this.logger.log("Bot token refreshed successfully");
    } catch (error: any) {
      this.logger.error("Bot token refresh failed", error.message);      
    }
  }

  async getValidAccessToken(): Promise<string> {
    const isExpired = Date.now() >= this.expiresAt - 60000;

    if (!this.accessToken) {
      await this.login();
    } else if (isExpired) {
      await this.refreshWithLock();
    }

    return this.accessToken!;
  }

  private async refreshWithLock() {
    if (this.refreshingPromise) {
      await this.refreshingPromise;
      return;
    }

    this.refreshingPromise = (async () => {
      try {
        await this.refresh();
      } catch (err) {
        this.logger.warn(
          'Refresh failed, trying login again...',
        );

        await this.login();
      } finally {
        this.refreshingPromise = null;
      }
    })();

    await this.refreshingPromise;
  }

  private setTokens(data: any) {
    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token;

    this.expiresAt = Date.now() + data.expires_in * 1000;
  }
}
