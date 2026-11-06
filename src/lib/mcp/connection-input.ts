import { z } from "zod";

import { idSchema } from "@/lib/zod";

/** At most this many live connections per person. */
export const MAX_MCP_CONNECTIONS = 20;

export const createConnectionSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    access: z.enum(["read", "write"]),
    allGroups: z.boolean(),
    groupIds: z.array(idSchema).max(200).default([]),
    /** Omitted = never expires. */
    expiresInDays: z.number().int().min(1).max(365).optional(),
  })
  .refine((v) => v.allGroups || v.groupIds.length > 0, {
    message: "choose at least one group, or all groups",
  });

export type CreateConnectionInput = z.infer<typeof createConnectionSchema>;
