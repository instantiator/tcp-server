import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCompanyDescription1782144931792 implements MigrationInterface {
  name = 'AddCompanyDescription1782144931792';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "lcp_role" DROP CONSTRAINT "FK_lcp_role_company"`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_agent" DROP CONSTRAINT "FK_lcp_agent_company"`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_agent" DROP CONSTRAINT "FK_lcp_agent_role"`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_event" DROP CONSTRAINT "FK_audit_event_company"`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_event" DROP CONSTRAINT "FK_audit_event_agent"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_audit_event_company_agent_timestamp"`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_company" ADD "description" character varying NOT NULL`,
    );
    await queryRunner.query(`ALTER TABLE "lcp_agent" DROP COLUMN "createdAt"`);
    await queryRunner.query(
      `ALTER TABLE "lcp_agent" ADD "createdAt" TIMESTAMP NOT NULL DEFAULT now()`,
    );
    await queryRunner.query(`ALTER TABLE "lcp_agent" DROP COLUMN "updatedAt"`);
    await queryRunner.query(
      `ALTER TABLE "lcp_agent" ADD "updatedAt" TIMESTAMP NOT NULL DEFAULT now()`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_event" DROP COLUMN "timestamp"`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_event" ADD "timestamp" TIMESTAMP NOT NULL DEFAULT now()`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_21809998b97684e8545d7653f0" ON "audit_event"  ("companyId", "agentId", "timestamp") `,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_role" ADD CONSTRAINT "FK_a58bcccbca1f1c5b8613c425e02" FOREIGN KEY ("companyId") REFERENCES "lcp_company"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_agent" ADD CONSTRAINT "FK_6864ef152d064f9d701c00eafda" FOREIGN KEY ("companyId") REFERENCES "lcp_company"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_agent" ADD CONSTRAINT "FK_56d823693bf1338315037931939" FOREIGN KEY ("roleId") REFERENCES "lcp_role"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_event" ADD CONSTRAINT "FK_9e16b38f657682dd5ddd2048761" FOREIGN KEY ("companyId") REFERENCES "lcp_company"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_event" ADD CONSTRAINT "FK_6800c287616e1c337551af9c33a" FOREIGN KEY ("agentId") REFERENCES "lcp_agent"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "audit_event" DROP CONSTRAINT "FK_6800c287616e1c337551af9c33a"`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_event" DROP CONSTRAINT "FK_9e16b38f657682dd5ddd2048761"`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_agent" DROP CONSTRAINT "FK_56d823693bf1338315037931939"`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_agent" DROP CONSTRAINT "FK_6864ef152d064f9d701c00eafda"`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_role" DROP CONSTRAINT "FK_a58bcccbca1f1c5b8613c425e02"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_21809998b97684e8545d7653f0"`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_event" DROP COLUMN "timestamp"`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_event" ADD "timestamp" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`,
    );
    await queryRunner.query(`ALTER TABLE "lcp_agent" DROP COLUMN "updatedAt"`);
    await queryRunner.query(
      `ALTER TABLE "lcp_agent" ADD "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`,
    );
    await queryRunner.query(`ALTER TABLE "lcp_agent" DROP COLUMN "createdAt"`);
    await queryRunner.query(
      `ALTER TABLE "lcp_agent" ADD "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_company" DROP COLUMN "description"`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_event_company_agent_timestamp" ON "audit_event" USING btree ("timestamp", "companyId", "agentId") `,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_event" ADD CONSTRAINT "FK_audit_event_agent" FOREIGN KEY ("agentId") REFERENCES "lcp_agent"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_event" ADD CONSTRAINT "FK_audit_event_company" FOREIGN KEY ("companyId") REFERENCES "lcp_company"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_agent" ADD CONSTRAINT "FK_lcp_agent_role" FOREIGN KEY ("roleId") REFERENCES "lcp_role"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_agent" ADD CONSTRAINT "FK_lcp_agent_company" FOREIGN KEY ("companyId") REFERENCES "lcp_company"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_role" ADD CONSTRAINT "FK_lcp_role_company" FOREIGN KEY ("companyId") REFERENCES "lcp_company"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }
}
