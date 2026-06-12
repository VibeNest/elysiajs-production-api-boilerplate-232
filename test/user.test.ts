import { beforeAll, describe, expect, it } from "bun:test";
import { api, body, json, registerUser, uniqueEmail } from "./helpers";

describe("user authorization (permission model)", () => {
  let userA: Awaited<ReturnType<typeof registerUser>>;
  let userB: Awaited<ReturnType<typeof registerUser>>;
  let admin: Awaited<ReturnType<typeof registerUser>>;

  beforeAll(async () => {
    userA = await registerUser();
    userB = await registerUser();
    admin = await registerUser({ admin: true });
  });

  // --- read (user:read:own vs :all) ---
  it("lets a user read their own record", async () => {
    const res = await api(`/users/${userA.id}`, {
      headers: { Authorization: `Bearer ${userA.accessToken}` },
    });
    expect(res.status).toBe(200);
    expect((await body(res)).id).toBe(userA.id);
  });

  it("forbids a user from reading another user", async () => {
    const res = await api(`/users/${userB.id}`, {
      headers: { Authorization: `Bearer ${userA.accessToken}` },
    });
    expect(res.status).toBe(403);
  });

  it("lets an admin read any user", async () => {
    const res = await api(`/users/${userA.id}`, {
      headers: { Authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.status).toBe(200);
  });

  it("requires authentication", async () => {
    const res = await api(`/users/${userA.id}`);
    expect(res.status).toBe(401);
  });

  // --- list (own scope returns only self) ---
  it("returns only self for a non-admin list", async () => {
    const res = await api("/users", {
      headers: { Authorization: `Bearer ${userA.accessToken}` },
    });
    expect(res.status).toBe(200);
    const rows = await body(res);
    expect(rows).toBeArrayOfSize(1);
    expect(rows[0].id).toBe(userA.id);
  });

  it("returns all users for an admin list", async () => {
    const res = await api("/users", {
      headers: { Authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.status).toBe(200);
    expect((await body(res)).length).toBeGreaterThanOrEqual(3);
  });

  // --- update (self vs admin; field-level role guard) ---
  it("lets a user update their own name", async () => {
    const res = await json(
      `/users/${userA.id}`,
      "PATCH",
      { name: "Renamed A" },
      userA.accessToken,
    );
    expect(res.status).toBe(200);
    expect((await body(res)).name).toBe("Renamed A");
  });

  it("forbids a non-admin from changing their own role", async () => {
    const res = await json(
      `/users/${userA.id}`,
      "PATCH",
      { role: "admin" },
      userA.accessToken,
    );
    expect(res.status).toBe(403);
  });

  it("forbids a user from updating another user", async () => {
    const res = await json(
      `/users/${userB.id}`,
      "PATCH",
      { name: "hacked" },
      userA.accessToken,
    );
    expect(res.status).toBe(403);
  });

  it("lets an admin change another user's role", async () => {
    const res = await json(
      `/users/${userB.id}`,
      "PATCH",
      { role: "admin" },
      admin.accessToken,
    );
    expect(res.status).toBe(200);
    expect((await body(res)).role).toBe("admin");
  });

  // --- delete (self vs admin) — destructive, kept last ---
  it("forbids a user from deleting another user", async () => {
    const res = await api(`/users/${admin.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${userA.accessToken}` },
    });
    expect(res.status).toBe(403);
  });

  it("lets a user delete their own account", async () => {
    const res = await api(`/users/${userA.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${userA.accessToken}` },
    });
    expect(res.status).toBe(200);
  });
});

describe("public user shape is consistent across modules", () => {
  const PUBLIC_KEYS = [
    "id",
    "email",
    "name",
    "role",
    "emailVerified",
    "createdAt",
  ].sort();

  it("auth /register returns the full public-user shape including createdAt", async () => {
    const res = await json("/auth/register", "POST", {
      email: uniqueEmail(),
      password: "supersecret",
    });
    const { user } = await body(res);
    expect(Object.keys(user).sort()).toEqual(PUBLIC_KEYS);
    expect(user.createdAt).toBeDefined();
  });

  it("users /:id returns the same shape", async () => {
    const u = await registerUser();
    const res = await json(`/users/${u.id}`, "GET", undefined, u.accessToken);
    const dto = await body(res);
    expect(Object.keys(dto).sort()).toEqual(PUBLIC_KEYS);
  });
});

describe("list pagination is deterministic", () => {
  it("returns a stable, non-overlapping order across pages", async () => {
    const admin = await registerUser({ admin: true });
    const createdIds = [admin.id];
    // Seed extra users so paging spans multiple pages; the test's users are
    // the newest rows, so they sort to the top of the createdAt-desc listing.
    for (let i = 0; i < 5; i++) createdIds.push((await registerUser()).id);

    const page = (limit: number, offset: number) =>
      json(
        `/users?limit=${limit}&offset=${offset}`,
        "GET",
        undefined,
        admin.accessToken,
      ).then(body);

    const all = await page(100, 0);
    const topIds = all
      .map((u: { id: string }) => u.id)
      .slice(0, createdIds.length);

    // The newest `createdIds.length` rows are exactly this test's users.
    expect(new Set(topIds)).toEqual(new Set(createdIds));
    // No duplicates across the page boundary within that range.
    expect(new Set(topIds).size).toBe(topIds.length);

    // Stitching two consecutive pages reproduces the same order — no skips/repeats.
    const first = await page(3, 0);
    const second = await page(3, 3);
    const stitched = [...first, ...second].map((u: { id: string }) => u.id);
    expect(stitched).toEqual(topIds);
  });
});
