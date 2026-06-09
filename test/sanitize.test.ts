import { describe, expect, it } from "bun:test";
import { sanitizeText } from "../src/lib/sanitize";
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
