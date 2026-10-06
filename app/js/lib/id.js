// Short random ids, for records the app keeps (its `_id`s). 12 characters of 0-9a-z, about 62 bits, from the browser's
// cryptographic random numbers.

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const LENGTH = 12;

export function uid() {
  let id = "";
  while (id.length < LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(LENGTH * 2))) {
      // 252 = 7 × 36: bytes above it would make the first letters likelier
      if (byte < 252 && id.length < LENGTH) id += ALPHABET[byte % 36];
    }
  }
  return id;
}
