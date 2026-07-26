/** Normalize only line-ending representation; preserve all other bytes. */
export function normalizeEol(text) {
  return text.replace(/\r\n?/g, "\n");
}

export function textEqualIgnoringEol(left, right) {
  return normalizeEol(left) === normalizeEol(right);
}
