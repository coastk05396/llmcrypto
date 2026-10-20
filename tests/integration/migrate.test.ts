import { cpSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_MIGRATIONS_DIR } from "../../apps/api/src/config";
import { migrate, openPglite } from "../../apps/api/src/db";

describe("migrate", () => {
  it("concurrent migrators apply each file exactly once", async () => {
    const db = await openPglite();
    const [a, b] = await Promise.all([migrate(db, DEFAULT_MIGRATIONS_DIR), migrate(db, DEFAULT_MIGRATIONS_DIR)]);
    const total = readdirSync(DEFAULT_MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).length;
    expect(a.applied.length + b.applied.length).toBe(total);
    expect(a.skipped.length + b.skipped.length).toBe(total);
    expect((await db.query<{ n: number }>("select count(*)::int n from schema_migrations"))[0]!.n).toBe(total);
    await db.close();
  });

  it("documentation-only edits (comments) are not a changed migration; statement edits still are", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    cpSync(DEFAULT_MIGRATIONS_DIR, dir, { recursive: true });
    const db = await openPglite();
    await migrate(db, dir);
    const file = join(dir, "002_keys.sql");
    writeFileSync(file, `-- a new rollback note\n${readFileSync(file, "utf8")}\n\n-- trailing comment\n`);
    expect((await migrate(db, dir)).applied).toEqual([]);
    writeFileSync(file, `${readFileSync(file, "utf8")}\nselect 1;\n`);
    await expect(migrate(db, dir)).rejects.toThrow(/changed after being applied/);
    await db.close();
  });
});
