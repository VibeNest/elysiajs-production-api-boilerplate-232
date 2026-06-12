import { t } from "elysia";
import sanitizeHtml from "sanitize-html";
import { BadRequestError } from "@/lib/errors";

/**
 * Strip all HTML/script from a string, leaving plain text.
 * `<script>alert(1)</script>` → "", `<b>hi</b>` → "hi".
 */
export function sanitizeText(input: string): string {
  return sanitizeHtml(input, {
    allowedTags: [],
    allowedAttributes: {},
  }).trim();
}

// Coarse cap on the RAW input so a pathologically large payload never reaches
// sanitize-html. The semantic min/max are enforced on the sanitized output,
// where they actually mean what the caller intends.
const RAW_MAX_LENGTH = 64 * 1024;

/**
 * TypeBox transform for user free-text fields: validates as a string and
 * sanitizes it during decoding, so handlers receive clean plain text. Use for
 * names, titles, bios, etc. — never for passwords, tokens, or format-validated
 * fields (email, etc.).
 *
 * Length is checked on the SANITIZED output, not the raw input — stripping HTML
 * changes the length, so validating the raw string would accept values that
 * sanitize to empty and reject values whose real text fits.
 *
 * Note: `maxLength` is implicitly capped by RAW_MAX_LENGTH (65536) — a caller
 * passing a larger maxLength would see the raw cap reject oversized input first.
 */
export const sanitizedString = (opts?: {
  minLength?: number;
  maxLength?: number;
}) =>
  t
    .Transform(t.String({ maxLength: RAW_MAX_LENGTH }))
    .Decode((value) => {
      const clean = sanitizeText(value);
      if (opts?.minLength !== undefined && clean.length < opts.minLength)
        throw new BadRequestError(
          `Value must be at least ${opts.minLength} character(s)`,
        );
      if (opts?.maxLength !== undefined && clean.length > opts.maxLength)
        throw new BadRequestError(
          `Value must be at most ${opts.maxLength} character(s)`,
        );
      return clean;
    })
    .Encode((value) => value);
