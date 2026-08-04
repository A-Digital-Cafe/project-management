import { Type } from "@sinclair/typebox";

/** Schemas TypeBox para los endpoints de proyectos de ProjectManagerService. */

const VisibilitySchema = Type.Union([Type.Literal("private"), Type.Literal("org"), Type.Literal("public")]);

// ── Sub-entidades ──────────────────────────────────────────────────────────

const KanbanColumnSchema = Type.Object({
	id: Type.String(),
	key: Type.String(),
	name: Type.String(),
	order: Type.Number(),
	color: Type.Optional(Type.String()),
	isDone: Type.Optional(Type.Boolean({ description: 'Columna "finalizado" (setea `closedAt`)' })),
	isAuto: Type.Optional(Type.Boolean({ description: "Columna por defecto para issues nuevos" })),
});

const PriorityStrategySchema = Type.Object({
	id: Type.Union([Type.Literal("matrix-eisenhower"), Type.Literal("weighted-sum"), Type.Literal("wsjf-like")]),
	weights: Type.Optional(Type.Object({ urgency: Type.Number(), importance: Type.Number(), difficulty: Type.Number() })),
});

const ProjectSettingsSchema = Type.Object({
	wipLimits: Type.Optional(Type.Record(Type.String(), Type.Number())),
	requireCommentOnFinalTransition: Type.Optional(Type.Boolean()),
});

const CustomFieldDefSchema = Type.Object({
	id: Type.String(),
	name: Type.String(),
	type: Type.Union([
		Type.Literal("date"),
		Type.Literal("label"),
		Type.Literal("text"),
		Type.Literal("user"),
		Type.Literal("number"),
		Type.Literal("badge"),
	]),
	options: Type.Optional(Type.Array(Type.String(), { description: 'Solo para `type = "label"`' })),
	badgeOptions: Type.Optional(Type.Array(Type.Object({ name: Type.String(), color: Type.String() }))),
	required: Type.Optional(Type.Boolean()),
});

const IssueLinkTypeSchema = Type.Object({
	id: Type.String(),
	name: Type.String(),
	inverseName: Type.String(),
	color: Type.String(),
});

const ProjectRoleOverrideSchema = Type.Object({
	roleId: Type.String(),
	permissions: Type.Array(Type.Object({ scope: Type.Number(), action: Type.Number() })),
});

// ── Entidad ──────────────────────────────────────────────────────────────

export const ProjectResponse = Type.Object({
	id: Type.String(),
	orgId: Type.Union([Type.String(), Type.Null()], { description: "null = proyecto global" }),
	slug: Type.String(),
	name: Type.String(),
	description: Type.Optional(Type.String()),
	ownerId: Type.String(),
	visibility: VisibilitySchema,
	memberUserIds: Type.Array(Type.String()),
	memberGroupIds: Type.Array(Type.String()),
	roleOverrides: Type.Array(ProjectRoleOverrideSchema),
	kanbanColumns: Type.Array(KanbanColumnSchema),
	customFieldDefs: Type.Array(CustomFieldDefSchema),
	issueLinkTypes: Type.Array(IssueLinkTypeSchema),
	priorityStrategy: PriorityStrategySchema,
	settings: ProjectSettingsSchema,
	issueCounter: Type.Integer({ description: "Contador autoincremental para issue keys" }),
	createdAt: Type.String({ format: "date-time" }),
	updatedAt: Type.String({ format: "date-time" }),
});

export const ProjectsListResponse = Type.Object({ projects: Type.Array(ProjectResponse) });

export const CheckSlugResponse = Type.Object({ available: Type.Boolean() });

export const OrgProjectSlugParams = Type.Object({
	orgSlug: Type.String({ minLength: 1, description: 'Slug de la organización ("default" = contexto global)' }),
	projectSlug: Type.String({ minLength: 1, description: "Slug del proyecto" }),
});

export const CreateProjectBody = Type.Object({
	name: Type.String({ minLength: 1, description: "Nombre del proyecto" }),
	slug: Type.String({ minLength: 1, description: "Slug único en la org (se normaliza en servidor)" }),
	description: Type.Optional(Type.String()),
	visibility: Type.Optional(VisibilitySchema),
	orgId: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Solo admin global" })),
	memberUserIds: Type.Optional(Type.Array(Type.String())),
	memberGroupIds: Type.Optional(Type.Array(Type.String())),
	kanbanColumns: Type.Optional(Type.Array(KanbanColumnSchema)),
	customFieldDefs: Type.Optional(Type.Array(CustomFieldDefSchema)),
	issueLinkTypes: Type.Optional(Type.Array(IssueLinkTypeSchema)),
	priorityStrategy: Type.Optional(PriorityStrategySchema),
	settings: Type.Optional(ProjectSettingsSchema),
});

export const UpdateProjectBody = Type.Partial(
	Type.Object({
		name: Type.String({ minLength: 1 }),
		slug: Type.String({ minLength: 1 }),
		description: Type.String(),
		visibility: VisibilitySchema,
		memberUserIds: Type.Array(Type.String()),
		memberGroupIds: Type.Array(Type.String()),
		roleOverrides: Type.Array(ProjectRoleOverrideSchema),
		kanbanColumns: Type.Array(KanbanColumnSchema),
		customFieldDefs: Type.Array(CustomFieldDefSchema),
		issueLinkTypes: Type.Array(IssueLinkTypeSchema),
		priorityStrategy: PriorityStrategySchema,
		settings: ProjectSettingsSchema,
	})
);

export const UpdateMembersBody = Type.Object({
	memberUserIds: Type.Array(Type.String()),
	memberGroupIds: Type.Array(Type.String()),
});

export const UpdateColumnsBody = Type.Object({ kanbanColumns: Type.Array(KanbanColumnSchema) });

export const UpdateCustomFieldsBody = Type.Object({ customFieldDefs: Type.Array(CustomFieldDefSchema) });

export const UpdateLinkTypesBody = Type.Object({ issueLinkTypes: Type.Array(IssueLinkTypeSchema) });

export const UpdatePriorityStrategyBody = Type.Object({ priorityStrategy: PriorityStrategySchema });

export const UpdateSettingsBody = Type.Object({ settings: ProjectSettingsSchema });
