import { MigrationInterface, QueryRunner } from "typeorm";

export class UpdateTestDB1772691863467 implements MigrationInterface {
    name = 'UpdateTestDB1772691863467'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "interview_sessions" ADD "isExternal" boolean NOT NULL DEFAULT false`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "interview_sessions" DROP COLUMN "isExternal"`);
    }

}
