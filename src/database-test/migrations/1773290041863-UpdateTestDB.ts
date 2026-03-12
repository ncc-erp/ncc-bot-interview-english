import { MigrationInterface, QueryRunner } from "typeorm";

export class UpdateTestDB1773290041863 implements MigrationInterface {
    name = 'UpdateTestDB1773290041863'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "interview_sessions" ADD "audioFile" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "interview_sessions" DROP COLUMN "audioFile"`);
    }

}
