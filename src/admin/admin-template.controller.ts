import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  InterviewTemplate,
  InterviewLevel,
  InterviewType,
  QuestionSection,
} from '@/database-test/entities/interview-template.entity';

export class CreateTemplateDto {
  name: string;
  description: string;
  type: InterviewType;
  level: InterviewLevel;
  systemPrompt: string;
  sampleQuestions: string[];
  numberOfQuestions: number;
  questionSections?: QuestionSection[];
  isActive?: boolean;
}

export class UpdateTemplateDto {
  name?: string;
  description?: string;
  type?: InterviewType;
  level?: InterviewLevel;
  systemPrompt?: string;
  sampleQuestions?: string[];
  numberOfQuestions?: number;
  questionSections?: QuestionSection[];
  isActive?: boolean;
}

@Controller('admin/templates')
export class AdminTemplateController {
  constructor(
    @InjectRepository(InterviewTemplate)
    private readonly templateRepo: Repository<InterviewTemplate>,
  ) {}

  /**
   * GET /admin/templates
   * List all templates
   */
  @Get()
  @HttpCode(HttpStatus.OK)
  async getTemplates(): Promise<InterviewTemplate[]> {
    return this.templateRepo.find({
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * GET /admin/templates/:id
   * Get single template
   */
  @Get(':id')
  @HttpCode(HttpStatus.OK)
  async getTemplate(@Param('id') id: string): Promise<InterviewTemplate> {
    const template = await this.templateRepo.findOne({ where: { id } });
    if (!template) throw new NotFoundException(`Template ${id} not found`);
    return template;
  }

  /**
   * POST /admin/templates
   * Create new template
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createTemplate(@Body() dto: CreateTemplateDto): Promise<InterviewTemplate> {
    if (!dto.name?.trim()) throw new BadRequestException('Name is required');
    if (!dto.systemPrompt?.trim()) throw new BadRequestException('System prompt is required');

    const template = this.templateRepo.create({
      name: dto.name.trim(),
      description: dto.description?.trim() ?? '',
      type: dto.type ?? InterviewType.GENERAL,
      level: dto.level ?? InterviewLevel.INTERMEDIATE,
      systemPrompt: dto.systemPrompt.trim(),
      sampleQuestions: dto.sampleQuestions ?? [],
      numberOfQuestions: dto.numberOfQuestions ?? 5,
      questionSections: dto.questionSections ?? null,
      isActive: dto.isActive ?? true,
    });

    return this.templateRepo.save(template);
  }

  /**
   * PUT /admin/templates/:id
   * Update template
   */
  @Put(':id')
  @HttpCode(HttpStatus.OK)
  async updateTemplate(
    @Param('id') id: string,
    @Body() dto: UpdateTemplateDto,
  ): Promise<InterviewTemplate> {
    const template = await this.templateRepo.findOne({ where: { id } });
    if (!template) throw new NotFoundException(`Template ${id} not found`);

    Object.assign(template, {
      ...(dto.name !== undefined && { name: dto.name.trim() }),
      ...(dto.description !== undefined && { description: dto.description.trim() }),
      ...(dto.type !== undefined && { type: dto.type }),
      ...(dto.level !== undefined && { level: dto.level }),
      ...(dto.systemPrompt !== undefined && { systemPrompt: dto.systemPrompt.trim() }),
      ...(dto.sampleQuestions !== undefined && { sampleQuestions: dto.sampleQuestions }),
      ...(dto.numberOfQuestions !== undefined && { numberOfQuestions: dto.numberOfQuestions }),
      ...(dto.questionSections !== undefined && { questionSections: dto.questionSections }),
      ...(dto.isActive !== undefined && { isActive: dto.isActive }),
    });

    return this.templateRepo.save(template);
  }

  /**
   * DELETE /admin/templates/:id
   * Delete template (hard delete)
   */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async deleteTemplate(@Param('id') id: string): Promise<{ message: string }> {
    const template = await this.templateRepo.findOne({ where: { id } });
    if (!template) throw new NotFoundException(`Template ${id} not found`);
    await this.templateRepo.remove(template);
    return { message: `Template "${template.name}" deleted successfully` };
  }
}