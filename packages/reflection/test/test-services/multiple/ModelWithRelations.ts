export class Model1 {
  public Owner: Model2;
}

export class Model2 {
  public Many: Model1[];
}
