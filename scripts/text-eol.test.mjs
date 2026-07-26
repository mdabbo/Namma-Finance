import assert from "node:assert/strict";
import test from "node:test";
import { normalizeEol, textEqualIgnoringEol } from "./text-eol.mjs";

test("release metadata comparison accepts Windows and Unix line endings", () => {
  const lf = '{\n  "version": "0.6.7"\n}\n';
  const crlf = lf.replaceAll("\n", "\r\n");
  assert.equal(textEqualIgnoringEol(lf, crlf), true);
  assert.equal(normalizeEol(crlf), lf);
});

test("release metadata comparison still rejects content and newline changes", () => {
  assert.equal(textEqualIgnoringEol("version=0.6.7\n", "version=0.6.8\r\n"), false);
  assert.equal(textEqualIgnoringEol("version=0.6.7\n", "version=0.6.7"), false);
});
