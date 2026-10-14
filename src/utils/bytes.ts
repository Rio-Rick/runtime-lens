/**
 * UTF-8 byte length of a string without `Buffer`.
 *
 * The agent is bundled for browsers as well as Node, and `Buffer` does not
 * exist in a browser: using `Buffer.byteLength` there throws a ReferenceError
 * from the flush timer on every tick, so no event ever leaves the page.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4; // surrogate pair = one 4-byte code point
        i++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
