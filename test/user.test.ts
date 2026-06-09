import { beforeAll, describe, expect, it } from "bun:test";
import { api, body, json, registerUser } from "./helpers";

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
