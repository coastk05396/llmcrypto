import { Hono } from "hono";
import { CatalogQuery, type CatalogModel, type CatalogResponse } from "@llmcrypto/contracts";
import { parseWith, type AppEnv } from "../http";
import { SAMPLE_CATALOG, SAMPLE_PRICING_VERSION } from "./seed";

export const catalogModelIds = (): Set<string> => new Set(SAMPLE_CATALOG.map((x) => x.id));

export const findCatalogModel = (id: string): CatalogModel | undefined => SAMPLE_CATALOG.find((x) => x.id === id);

export function filterCatalog(q: { provider?: string | undefined; search?: string | undefined }): CatalogModel[] {
  const provider = q.provider?.toLowerCase();
  const search = q.search?.toLowerCase();
  return SAMPLE_CATALOG.filter(
    (x) => (!provider || x.provider.toLowerCase() === provider) && (!search || x.id.toLowerCase().includes(search) || x.displayName.toLowerCase().includes(search)),
  );
}

export function catalogRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get("/catalog", (c) => {
    const q = parseWith(CatalogQuery, c.req.query());
    const body: CatalogResponse = { pricingVersion: SAMPLE_PRICING_VERSION, items: filterCatalog(q) };
    c.header("Cache-Control", "public, max-age=60");
    return c.json(body);
  });
  return app;
}
