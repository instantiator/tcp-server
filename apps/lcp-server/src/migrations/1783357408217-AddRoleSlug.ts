import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds a `slug` column to `lcp_role`, as part of the internal-consistency
 * pass (`docs/prompts/009.2 - internal consistency plan.md`) that lets
 * `lcp-cli`/the API/`lcp-agent` address roles by a human-readable identifier
 * instead of only by UUID.
 *
 * Unlike `lcp_company.slug` (globally unique, present since the initial
 * schema), role slugs are unique **per company** — the same slug may be
 * reused across different companies. Existing rows have no slug yet, so
 * this migration backfills one from each role's `name` (lowercased,
 * non-alphanumeric runs collapsed to `-`), de-duplicating within a company
 * by appending `-2`, `-3`, ... on collision, before making the column
 * `NOT NULL` and adding the composite unique index.
 */
export class AddRoleSlug1783357408217 implements MigrationInterface {
  name = 'AddRoleSlug1783357408217';

  private slugify(name: string): string {
    const base = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return base || 'role';
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "lcp_role" ADD COLUMN IF NOT EXISTS "slug" character varying`,
    );

    const roles = (await queryRunner.query(
      `SELECT "id", "companyId", "name" FROM "lcp_role" WHERE "slug" IS NULL ORDER BY "companyId", "id"`,
    )) as Array<{ id: string; companyId: string; name: string }>;

    const usedSlugsByCompany = new Map<string, Set<string>>();
    for (const role of roles) {
      const used = usedSlugsByCompany.get(role.companyId) ?? new Set<string>();
      usedSlugsByCompany.set(role.companyId, used);

      const base = this.slugify(role.name);
      let candidate = base;
      let suffix = 2;
      while (used.has(candidate)) {
        candidate = `${base}-${suffix}`;
        suffix += 1;
      }
      used.add(candidate);

      await queryRunner.query(
        `UPDATE "lcp_role" SET "slug" = $1 WHERE "id" = $2`,
        [candidate, role.id],
      );
    }

    await queryRunner.query(
      `ALTER TABLE "lcp_role" ALTER COLUMN "slug" SET NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_lcp_role_company_slug" ON "lcp_role" ("companyId", "slug")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_lcp_role_company_slug"`);
    await queryRunner.query(
      `ALTER TABLE "lcp_role" DROP COLUMN IF EXISTS "slug"`,
    );
  }
}
