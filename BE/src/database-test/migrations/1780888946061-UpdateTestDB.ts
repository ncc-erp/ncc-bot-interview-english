import { MigrationInterface, QueryRunner } from "typeorm";

export class UpdateTestDB1780888946061 implements MigrationInterface {
    name = 'UpdateTestDB1780888946061'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "admins" ("id" uuid NOT NULL DEFAULT public.uuid_generate_v4(), "username" character varying(50) NOT NULL, "passwordHash" character varying(255) NOT NULL, "refreshToken" character varying(255), "refreshTokenExpiresAt" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_4ba6d0c734d53f8e1b2e24b6c56" UNIQUE ("username"), CONSTRAINT "PK_e3b38270c97a854c48d2e80874e" PRIMARY KEY ("id"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "admins"`);
    }

}
