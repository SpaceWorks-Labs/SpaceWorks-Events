import { z } from "zod";

export const slugParam = z.string().trim().min(1).max(160);
export const idParam = z.string().trim().min(1).max(128);

export const discoverQuerySchema = z.object({
  cursor: z.string().min(1).max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
}).strict();
