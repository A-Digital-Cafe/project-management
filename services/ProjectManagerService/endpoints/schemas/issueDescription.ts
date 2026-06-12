import { Type } from "@sinclair/typebox";
import { BlockSchema } from "./common.js";

/** Schemas TypeBox para los endpoints de borradores de descripción de issues. */

export const SaveDescriptionDraftBody = Type.Object({
	blocks: Type.Array(BlockSchema),
	attachmentIds: Type.Optional(Type.Array(Type.String())),
});

const DescriptionDraftSchema = Type.Object({
	blocks: Type.Array(BlockSchema),
	attachmentIds: Type.Optional(Type.Array(Type.String())),
	updatedAt: Type.Optional(Type.String({ format: "date-time" })),
});

export const IssueDescriptionDraftResponse = Type.Object({
	draft: Type.Union([DescriptionDraftSchema, Type.Null()]),
});
