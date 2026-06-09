import { t } from "elysia";
import sanitizeHtml from "sanitize-html";

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

/**
 * TypeBox transform for user free-text fields: validates as a string and
 * sanitizes it during decoding, so handlers receive clean plain text. Use for
 * names, titles, bios, etc. — never for passwords, tokens, or format-validated
 * fields (email, etc.).
 */
export const sanitizedString = (opts?: {
  minLength?: number;
  maxLength?: number;
}) =>
  t
    .Transform(
      t.String({ minLength: opts?.minLength, maxLength: opts?.maxLength }),
    )
    .Decode((value) => sanitizeText(value))
    .Encode((value) => value);
