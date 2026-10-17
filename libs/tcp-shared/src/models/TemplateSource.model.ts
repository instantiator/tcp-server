import type { UUID } from 'crypto';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Where a source's entry came from: the server's `TEMPLATE_SOURCES` setting
 * (kept in step with it at boot, and not removable in the UI), or an
 * administrator adding it.
 */
export type TemplateSourceOrigin = 'config' | 'user';

/**
 * A place the template gallery reads company templates from. The built-in
 * templates shipped with the server are not stored here.
 */
@Entity('template_source')
export class TemplateSource {
  /** @format uuid */
  @PrimaryGeneratedColumn('uuid')
  id!: UUID;

  /** What the gallery calls this source. */
  @Column({ type: 'varchar' })
  name!: string;

  /**
   * `github:<owner>/<repo>[/<path>][#<ref>]` or `dir:<absolute path>`.
   * Unique, so the same place can't be listed twice.
   */
  @Column({ type: 'varchar', unique: true })
  location!: string;

  @Column({ type: 'varchar' })
  origin!: TemplateSourceOrigin;

  @CreateDateColumn()
  createdAt!: Date;
}
