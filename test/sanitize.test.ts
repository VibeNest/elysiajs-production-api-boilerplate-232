import { describe, expect, it } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { sanitizedString, sanitizeText } from "@/lib/sanitize";
import { body, json, registerUser, uniqueEmail } from "./helpers";

describe("input sanitization", () => {
  it("strips HTML/script from text", () => {
    expect(sanitizeText("<script>alert(1)</script>Jane")).toBe("Jane");
    expect(sanitizeText("<b>hi</b>")).toBe("hi");
    expect(sanitizeText("plain name")).toBe("plain name");
  });

  it("sanitizes the name on register", async () => {
    const res = await json("/auth/register", "POST", {
      email: uniqueEmail(),
      password: "supersecret",
      name: "<script>alert('xss')</script>Jane",
    });
    expect(res.status).toBe(200);
    const { user } = await body(res);
    expect(user.name).toBe("Jane");
    expect(user.name).not.toContain("<");
  });

  it("sanitizes the name on user update", async () => {
    const u = await registerUser();
    const res = await json(
      `/users/${u.id}`,
      "PATCH",
      { name: "<img src=x onerror=alert(1)>Bob" },
      u.accessToken,
    );
    expect(res.status).toBe(200);
    expect((await body(res)).name).toBe("Bob");
  });

  it("leaves a clean name unchanged", async () => {
    const res = await json("/auth/register", "POST", {
      email: uniqueEmail(),
      password: "supersecret",
      name: "Ada Lovelace",
    });
    expect((await body(res)).user.name).toBe("Ada Lovelace");
  });
});

describe("sanitizedString length is validated after sanitization", () => {
  it("rejects input that is empty after sanitization when minLength is set", () => {
    const schema = sanitizedString({ minLength: 1, maxLength: 100 });
    expect(() => Value.Decode(schema, "<script></script>")).toThrow();
    expect(() => Value.Decode(schema, "   ")).toThrow(); // sanitizeText calls .trim(), so whitespace collapses to "" which then fails minLength
  });

  it("accepts HTML-wrapped input whose sanitized length fits maxLength", () => {
    const schema = sanitizedString({ maxLength: 10 });
    expect(
      Value.Decode(
        schema,
        '<a href="https://example.com/very/long/url">hi</a>',
      ),
    ).toBe("hi");
  });

  it("rejects input whose sanitized length exceeds maxLength", () => {
    const schema = sanitizedString({ maxLength: 3 });
    expect(() => Value.Decode(schema, "abcdef")).toThrow();
  });

  it("accepts ordinary text within bounds", () => {
    const schema = sanitizedString({ minLength: 1, maxLength: 100 });
    expect(Value.Decode(schema, "<b>hi</b>")).toBe("hi");
  });

  it("rejects a name longer than maxLength after sanitization with a 400", async () => {
    const res = await json("/auth/register", "POST", {
      email: uniqueEmail(),
      password: "supersecret",
      name: "a".repeat(300),
    });
    expect(res.status).toBe(400);
    const err = await body(res);
    expect(err.error).toBe("BAD_REQUEST");
    expect(err.message).toContain("255");
  });
});
