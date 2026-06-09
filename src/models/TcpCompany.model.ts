import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity()
export class TcpCompany {
  /** @format uuid */
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** @minLength 1 */
  @Column({ unique: true })
  slug!: string;

  /** @minLength 1 */
  @Column()
  name!: string;
}
