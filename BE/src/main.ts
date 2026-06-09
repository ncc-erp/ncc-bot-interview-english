import { NestFactory } from "@nestjs/core";
import { getQueueToken } from "@nestjs/bull";
import { ConfigService } from "@nestjs/config";
import { AppModule } from "@/app.module";
import { setupBullBoard } from "@/bull-board/bull-board.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: [
      'http://localhost:3001',   // Next.js local
      'http://localhost:3000',   // or same port if using proxy
      'http://172.16.100.184:3003', // dev
      process.env.ADMIN_ORIGIN, // production origin from env
    ].filter(Boolean) as string[],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  });

  const configService = app.get(ConfigService);

  const port = configService.get<number>('PORT')

  const ttsQueue = app.get(getQueueToken("tts"));
  const serverAdapter = setupBullBoard([ttsQueue]);

  app.use("/admin/queues", serverAdapter.getRouter());

  await app.listen(port);
  console.log(`Application is running on: http://localhost:${port}`);
  console.log(
    `Bull Board UI is available at: http://localhost:${port}/admin/queues`
  );
}
bootstrap();
