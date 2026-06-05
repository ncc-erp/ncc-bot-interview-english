import { MigrationInterface, QueryRunner } from "typeorm";

export class UpdateTestDB1780629478458 implements MigrationInterface {
    name = 'UpdateTestDB1780629478458'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "interview_sessions" ADD "candidateToken" character varying`);
        await queryRunner.query(`ALTER TABLE "interview_sessions" ADD CONSTRAINT "UQ_a3b7b6c47b881594b8f15a3c6dd" UNIQUE ("candidateToken")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "interview_sessions" DROP CONSTRAINT "UQ_a3b7b6c47b881594b8f15a3c6dd"`);
        await queryRunner.query(`ALTER TABLE "interview_sessions" DROP COLUMN "candidateToken"`);
    }

}
