declare const Base: new () => object;

export class Weird extends (Base as new () => {}) {}
