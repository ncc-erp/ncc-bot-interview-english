import { MigrationInterface, QueryRunner } from "typeorm";

export class AddTemplatePositionAndAiToggle1781517434849 implements MigrationInterface {
    name = 'AddTemplatePositionAndAiToggle1781517434849'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "interview_templates" ADD "position" character varying NOT NULL DEFAULT 'General'`);
        await queryRunner.query(`ALTER TABLE "interview_templates" ADD "isAiGenerated" boolean NOT NULL DEFAULT true`);
        await queryRunner.query(`ALTER TYPE "public"."interview_templates_level_enum" RENAME TO "interview_templates_level_enum_old"`);
        await queryRunner.query(`CREATE TYPE "public"."interview_templates_level_enum" AS ENUM('intern', 'fresher', 'junior', 'middle', 'senior', 'lead', 'manager', 'staff')`);
        await queryRunner.query(`ALTER TABLE "interview_templates" ALTER COLUMN "level" DROP DEFAULT`);
        await queryRunner.query(`ALTER TABLE "interview_templates" ALTER COLUMN "level" TYPE "public"."interview_templates_level_enum" USING (CASE "level"::text WHEN 'beginner' THEN 'fresher' WHEN 'intermediate' THEN 'staff' WHEN 'advanced' THEN 'senior' ELSE 'staff' END)::"public"."interview_templates_level_enum"`);
        await queryRunner.query(`ALTER TABLE "interview_templates" ALTER COLUMN "level" SET DEFAULT 'staff'`);
        await queryRunner.query(`DROP TYPE "public"."interview_templates_level_enum_old"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."interview_templates_level_enum_old" AS ENUM('beginner', 'intermediate', 'advanced')`);
        await queryRunner.query(`ALTER TABLE "interview_templates" ALTER COLUMN "level" DROP DEFAULT`);
        await queryRunner.query(`ALTER TABLE "interview_templates" ALTER COLUMN "level" TYPE "public"."interview_templates_level_enum_old" USING "level"::"text"::"public"."interview_templates_level_enum_old"`);
        await queryRunner.query(`ALTER TABLE "interview_templates" ALTER COLUMN "level" SET DEFAULT 'intermediate'`);
        await queryRunner.query(`DROP TYPE "public"."interview_templates_level_enum"`);
        await queryRunner.query(`ALTER TYPE "public"."interview_templates_level_enum_old" RENAME TO "interview_templates_level_enum"`);
        await queryRunner.query(`ALTER TABLE "interview_templates" DROP COLUMN "isAiGenerated"`);
        await queryRunner.query(`ALTER TABLE "interview_templates" DROP COLUMN "position"`);
    }

}
