import { ModelBase } from './model.js';

export function _update<T extends ModelBase>(data: Partial<T>): (user: T) => Promise<T> {
  return (model: T) => {
    return model.update(data).then(() => model);
  };
}
