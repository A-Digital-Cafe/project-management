import { Type } from "@sinclair/typebox";

/** Schemas TypeBox para los endpoints de milestones de ProjectManagerService. */

const MilestoneStatusSchema = Type.Union([
	Type.Literal("planned"),
	Type.Literal("active"),
	Type.Literal("completed"),
	Type.Literal("cancelled"),
]);

export const MilestoneResponse = Type.Object({
	id: Type.String(),
	projectId: Type.String(),
	name: Type.String(),
	description: Type.Optional(Type.String()),
	startDate: Type.Optional(Type.String({ format: "date-time" })),
	endDate: Type.Optional(Type.String({ format: "date-time" })),
	status: MilestoneStatusSchema,
	createdAt: Type.String({ format: "date-time" }),
});

export const MilestonesListResponse = Type.Object({ milestones: Type.Array(MilestoneResponse) });

export const CreateMilestoneBody = Type.Object({
	name: Type.String({ minLength: 1, description: "Nombre del milestone" }),
	description: Type.Optional(Type.String()),
	startDate: Type.Optional(Type.String({ format: "date-time" })),
	endDate: Type.Optional(Type.String({ format: "date-time" })),
	status: Type.Optional(MilestoneStatusSchema),
});

export const UpdateMilestoneBody = Type.Partial(
	Type.Object({
		name: Type.String({ minLength: 1 }),
		description: Type.String(),
		startDate: Type.String({ format: "date-time" }),
		endDate: Type.String({ format: "date-time" }),
		status: MilestoneStatusSchema,
	})
);
