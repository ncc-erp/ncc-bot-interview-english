import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule, InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { InterviewTemplate } from '../database-test/entities/interview-template.entity';
import { InterviewSession } from '../database-test/entities/interview-session-test.entity';
import { TemplateService } from '../interviewer/template.service';
import { UserService } from '@/interviewer/user.service';
import { User } from './entities/user-test.entity';
import { CustomPrompt } from './entities/custom-prompt.entity';
import { SessionMessage } from './entities/session-message.entity';
import { SystemSetting } from './entities/system-setting.entity';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get<string>('DB_HOST'),
        port: configService.get<number>('DB_PORT'),
        username: configService.get<string>('DB_USERNAME'),
        password: configService.get<string>('DB_PASSWORD'),
        database: configService.get<string>('DB_NAME'),
        entities: [User,
          CustomPrompt,
          InterviewTemplate,
          InterviewSession,
          SessionMessage,
          SystemSetting,],
        synchronize: configService.get<string>('NODE_ENV') === 'development',
        logging: false,
      }),
    }),
    TypeOrmModule.forFeature([User, CustomPrompt, InterviewTemplate, InterviewSession, SessionMessage, SystemSetting]),
  ],
  providers: [TemplateService, UserService],
  exports: [TemplateService, TypeOrmModule, UserService],
})
export class DatabaseTestModule implements OnModuleInit {
  constructor(
    private readonly templateService: TemplateService,
    @InjectRepository(SystemSetting)
    private readonly settingRepo: Repository<SystemSetting>,
  ) {}

  async onModuleInit() {
    await this.templateService.seedDefaultTemplates();
    
    // Seed default settings
    const existing = await this.settingRepo.findOne({ where: { key: 'send_result_link_to_candidate' } });
    if (!existing) {
      await this.settingRepo.save({
        key: 'send_result_link_to_candidate',
        value: 'true',
      });
      console.log('🌱 Seeded default system setting send_result_link_to_candidate = true');
    }
  }
}