declare namespace Express {
  // tslint:disable-next-line: interface-name
  interface Request {
    User?: import('@spinajs/rbac').User;
  }
}
