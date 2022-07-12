declare namespace Express {
  // tslint:disable-next-line: interface-name
  interface Request {
    storage: import('@spinajs/rbac').User;
  }
}
