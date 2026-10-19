import { z } from "zod";
import { Id, PageQuery, Timestamp, listEnvelope } from "./common";

export const CreateProjectRequest = z.strictObject({ name: z.string().trim().min(1).max(100) });
export const Project = z.object({ id: Id, name: z.string(), createdAt: Timestamp });
export const ProjectList = listEnvelope(Project);
export const ProjectListQuery = PageQuery;

export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;
export type Project = z.infer<typeof Project>;
export type ProjectList = z.infer<typeof ProjectList>;
