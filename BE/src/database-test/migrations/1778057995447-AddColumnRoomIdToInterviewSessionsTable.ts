import { MigrationInterface, QueryRunner } from "typeorm";

export class AddColumnRoomIdToInterviewSessionsTable1778057995447 implements MigrationInterface {
    name = 'AddColumnRoomIdToInterviewSessionsTable1778057995447'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "interview_sessions" ADD "roomId" character varying`);
        await queryRunner.query(`ALTER TYPE "public"."interview_sessions_status_enum" RENAME TO "interview_sessions_status_enum_old"`);
        await queryRunner.query(`CREATE TYPE "public"."interview_sessions_status_enum" AS ENUM('pending', 'in_progress', 'completed', 'cancelled', 'finished_session')`);
        await queryRunner.query(`ALTER TABLE "interview_sessions" ALTER COLUMN "status" DROP DEFAULT`);
        await queryRunner.query(`ALTER TABLE "interview_sessions" ALTER COLUMN "status" TYPE "public"."interview_sessions_status_enum" USING "status"::"text"::"public"."interview_sessions_status_enum"`);
        await queryRunner.query(`ALTER TABLE "interview_sessions" ALTER COLUMN "status" SET DEFAULT 'pending'`);
        await queryRunner.query(`DROP TYPE "public"."interview_sessions_status_enum_old"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."interview_sessions_status_enum_old" AS ENUM('pending', 'in_progress', 'completed', 'cancelled')`);
        await queryRunner.query(`ALTER TABLE "interview_sessions" ALTER COLUMN "status" DROP DEFAULT`);
        await queryRunner.query(`ALTER TABLE "interview_sessions" ALTER COLUMN "status" TYPE "public"."interview_sessions_status_enum_old" USING "status"::"text"::"public"."interview_sessions_status_enum_old"`);
        await queryRunner.query(`ALTER TABLE "interview_sessions" ALTER COLUMN "status" SET DEFAULT 'pending'`);
        await queryRunner.query(`DROP TYPE "public"."interview_sessions_status_enum"`);
        await queryRunner.query(`ALTER TYPE "public"."interview_sessions_status_enum_old" RENAME TO "interview_sessions_status_enum"`);
        await queryRunner.query(`ALTER TABLE "interview_sessions" DROP COLUMN "roomId"`);
    }

}
