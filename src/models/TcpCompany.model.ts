import { UUID } from 'crypto';
import { DataTypes, Model, type Sequelize } from 'sequelize';
import { RegisterModel } from '../db/model-registry';

@RegisterModel()
export class TcpCompany extends Model {
  declare id: UUID;
  declare slug: string;
  declare name: string;

  static register(sequelize: Sequelize) {
    TcpCompany.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          allowNull: false,
          defaultValue: DataTypes.UUIDV4,
        },
        slug: {
          type: DataTypes.TEXT,
          unique: true,
          allowNull: false,
        },
        name: {
          type: DataTypes.TEXT,
          allowNull: false,
        },
      },
      { sequelize },
    );
  }
}

export type NewTcpCompany = Omit<TcpCompany, 'id'>;
