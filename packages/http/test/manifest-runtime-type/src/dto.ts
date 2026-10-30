export class CreateUserDto {
  public name: string;
  public count: number;

  constructor(data: Partial<CreateUserDto>) {
    Object.assign(this, data);
  }
}

export class Counter {
  public readonly kind = 'counter';
}
