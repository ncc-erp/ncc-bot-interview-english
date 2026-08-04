import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';

export enum TemplateType {
  STANDARD = 1,
  IELTS = 2,
}

export type SectionType = 'STANDARD' | 'IELTS_PART1' | 'IELTS_PART2' | 'IELTS_PART3';

export interface QuestionSection {
  name: string;
  description?: string;
  type?: SectionType;
  questions: string[];
  questionsToSelect: number; // How many questions to randomly select from this section
  prepTimeSeconds?: number;
  speakingTimeSeconds?: number;
}

@Entity('interview_templates')
export class InterviewTemplate {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column()
  name: string;

  @Column({ type: 'int', default: TemplateType.STANDARD })
  type: number;

  @Column('text')
  description: string;

  @Column({ default: false })
  isAiGenerated: boolean;

  @Column('text')
  systemPrompt: string;

  @Column('simple-array')
  sampleQuestions: string[];
  // NEW: Structured sections for Non-AI templates
  @Column('jsonb', { nullable: true })
  questionSections: QuestionSection[];

  @Column({ default: 5 })
  numberOfQuestions: number;

  @Column({ default: true })
  isActive: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
