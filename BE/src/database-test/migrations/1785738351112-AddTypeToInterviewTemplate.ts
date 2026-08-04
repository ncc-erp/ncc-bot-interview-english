import { MigrationInterface, QueryRunner } from "typeorm";

export class AddTypeToInterviewTemplate1785738351112 implements MigrationInterface {
    name = 'AddTypeToInterviewTemplate1785738351112'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "interview_templates" ADD "type" integer NOT NULL DEFAULT '1'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "interview_templates" DROP COLUMN "type"`);
    }
}
