class Holder {
  constructor() {
    this.kept = true;
  }
  get computed() {
    return 42;
  }
}

module.exports = {
  stamp: new Date(0),
  holder: new Holder(),
  plain: { a: 1 },
};
