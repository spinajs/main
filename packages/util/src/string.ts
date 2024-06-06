export function trimChar(s: string, char: string) {
  var start = 0,
    end = s.length;

  while (start < end && s[start] === char) ++start;

  while (end > start && s[end - 1] === char) --end;

  return start > 0 || end < s.length ? s.substring(start, end) : s;
};
