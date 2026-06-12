import { Type } from "@sinclair/typebox";

/** Schemas TypeBox para los endpoints de sprints de ProjectManagerService. */

const SprintStatusSchema = Type.Union([Type.Literal("planned"), Type.Literal("active"), Type.Literal("completed")]);

export const SprintResponse = Type.Object({
	id: Type.String(),
	projectId: Type.String(),
	name: Type.String(),
	goal: Type.Optional(Type.String()),
	startDate: Type.Optional(Type.String({ format: "date-time" })),
	endDate: Type.Optional(Type.String({ format: "date-time" })),
	status: SprintStatusSchema,
	createdAt: Type.String({ format: "date-time" }),
	completedAt: Type.Optional(Type.String({ format: "date-time" })),
});

export const SprintsListResponse = Type.Object({ sprints: Type.Array(SprintResponse) });

export const CreateSprintBody = Type.Object({
	name: Type.String({ minLength: 1, description: "Nombre del sprint" }),
	goal: Type.Optional(Type.String()),
	startDate: Type.Optional(Type.String({ format: "date-time" })),
	endDate: Type.Optional(Type.String({ format: "date-time" })),
	status: Type.Optional(SprintStatusSchema),
});

export const UpdateSprintBody = Type.Partial(
	Type.Object({
		name: Type.String({ minLength: 1 }),
		goal: Type.String(),
		startDate: Type.String({ format: "date-time" }),
		endDate: Type.String({ format: "date-time" }),
		status: SprintStatusSchema,
	})
);
