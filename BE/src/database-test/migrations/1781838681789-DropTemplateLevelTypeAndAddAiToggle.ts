import { MigrationInterface, QueryRunner } from "typeorm";

export class DropTemplateLevelTypeAndAddAiToggle1781838681789 implements MigrationInterface {
    name = 'DropTemplateLevelTypeAndAddAiToggle1781838681789'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "interview_templates" DROP COLUMN "level"`);
        await queryRunner.query(`DROP TYPE "public"."interview_templates_level_enum"`);
        await queryRunner.query(`ALTER TABLE "interview_templates" DROP COLUMN "type"`);
        await queryRunner.query(`DROP TYPE "public"."interview_templates_type_enum"`);
        await queryRunner.query(`ALTER TABLE "interview_templates" ADD "isAiGenerated" boolean NOT NULL DEFAULT false`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "interview_templates" DROP COLUMN "isAiGenerated"`);
        await queryRunner.query(`CREATE TYPE "public"."interview_templates_type_enum" AS ENUM('general', 'technical', 'behavioral', 'situational')`);
        await queryRunner.query(`ALTER TABLE "interview_templates" ADD "type" "public"."interview_templates_type_enum" NOT NULL DEFAULT 'general'`);
        await queryRunner.query(`CREATE TYPE "public"."interview_templates_level_enum" AS ENUM('beginner', 'intermediate', 'advanced')`);
        await queryRunner.query(`ALTER TABLE "interview_templates" ADD "level" "public"."interview_templates_level_enum" NOT NULL DEFAULT 'intermediate'`);
    }

}
