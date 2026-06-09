import { type Sequelize, Model } from 'sequelize';

type RegisteredModelConstructor = typeof Model & {
  register(sequelize: Sequelize): void;
};

const registry: RegisteredModelConstructor[] = [];

export const RegisterModel = (): ClassDecorator => (target) => {
  registry.push(target as unknown as RegisteredModelConstructor);
};

export const getRegisteredModels = (): RegisteredModelConstructor[] => [
  ...registry,
];
