/**
 * SHA-256 hex digest. Used to store opaque secrets (e.g. refresh tokens) hashed
 * at rest so a database leak doesn't hand out usable credentials — the lookup
 * hashes the presented value and compares digests.
 */
export function sha256Hex(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}
