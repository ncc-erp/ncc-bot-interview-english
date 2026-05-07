import { Global, Module } from "@nestjs/common";
import { BotAuthService } from "./bot-auth.service";

@Global()
@Module({
  providers: [BotAuthService],
  exports: [BotAuthService],
})
export class BotAuthModule {}