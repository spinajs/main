declare global {
  interface String {

    /**
     * 
     * Removes the leading and trailing specified char from a string.
     * 
     * @param char specific char to trim
     */
    trimChar(char: string): string;
  }
}

String.prototype.trimChar = function (this: string, char: string) {
  var start = 0,
    end = this.length;

  while (start < end && this[start] === char) ++start;

  while (end > start && this[end - 1] === char) --end;

  return start > 0 || end < this.length ? this.substring(start, end) : this;
};
