declare namespace Express {
  interface IActionLocalStoregeContext {
    requestId: string;
    responseStart: Date;
  }

  // tslint:disable-next-line: interface-name
  interface Request {
    storage: IActionLocalStoregeContext;
  }
}
