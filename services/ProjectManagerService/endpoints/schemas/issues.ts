import { Type } from "@sinclair/typebox";
import { BlockSchema, AttachmentDto } from "./common.js";
import { ProjectResponse } from "./projects.js";

/** Schemas TypeBox para los endpoints de issues de ProjectManagerService. */

// ── Sub-entidades ──────────────────────────────────────────────────────────

const IssuePrioritySchema = Type.Object({
	urgency: Type.Integer({ description: "0..4 (none, low, medium, high, critical)" }),
	importance: Type.Integer({ description: "0..4 (none, low, medium, high, critical)" }),
	difficulty: Type.Union([Type.Integer(), Type.Null()], { description: "1..5; null = sin estimar" }),
});

const IssueLinkSchema = Type.Object({
	linkTypeId: Type.String(),
	targetIssueId: Type.String(),
});

const UpdateLogEntrySchema = Type.Object({
	at: Type.String({ format: "date-time" }),
	byUserId: Type.String(),
	field: Type.String(),
	oldValue: Type.Unknown(),
	newValue: Type.Unknown(),
	reason: Type.Optional(Type.String()),
});

const UserProfileSchema = Type.Object({
	username: Type.Optional(Type.String()),
	avatar: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const GroupProfileSchema = Type.Object({
	name: Type.String(),
	description: Type.Optional(Type.String()),
});

// ── Entidad ──────────────────────────────────────────────────────────────

export const IssueResponse = Type.Object({
	id: Type.String(),
	projectId: Type.String(),
	key: Type.String({ description: "Key human-readable, ej. PROJ-123" }),
	title: Type.String(),
	description: Type.Array(BlockSchema),
	columnKey: Type.String(),
	category: Type.String({ description: "task | bug | story | epic | (custom)" }),
	sprintId: Type.Optional(Type.String()),
	milestoneId: Type.Optional(Type.String()),
	reporterId: Type.String(),
	assigneeIds: Type.Array(Type.String()),
	assigneeGroupIds: Type.Array(Type.String()),
	assigneeProfiles: Type.Optional(Type.Record(Type.String(), UserProfileSchema)),
	assigneeGroupProfiles: Type.Optional(Type.Record(Type.String(), GroupProfileSchema)),
	priority: IssuePrioritySchema,
	storyPoints: Type.Optional(Type.Number()),
	customFields: Type.Record(Type.String(), Type.Unknown()),
	linkedIssues: Type.Array(IssueLinkSchema),
	attachments: Type.Optional(Type.Array(AttachmentDto)),
	updateLog: Type.Array(UpdateLogEntrySchema),
	createdAt: Type.String({ format: "date-time" }),
	updatedAt: Type.String({ format: "date-time" }),
	closedAt: Type.Optional(Type.String({ format: "date-time" })),
});

export const IssuesListResponse = Type.Object({
	issues: Type.Array(IssueResponse),
	project: ProjectResponse,
});

export const IssueHistoryResponse = Type.Object({ updateLog: Type.Array(UpdateLogEntrySchema) });

// ── Query ────────────────────────────────────────────────────────────────

export const ListIssuesQuery = Type.Object({
	sprintId: Type.Optional(Type.String()),
	milestoneId: Type.Optional(Type.String()),
	assigneeId: Type.Optional(Type.String()),
	columnKey: Type.Optional(Type.String()),
	q: Type.Optional(Type.String({ description: "Búsqueda por texto" })),
	orderBy: Type.Optional(Type.String({ description: "Campo de ordenación" })),
});

// ── Body ─────────────────────────────────────────────────────────────────

export const CreateIssueBody = Type.Object({
	title: Type.String({ minLength: 1, description: "Título del issue" }),
	description: Type.Optional(Type.Array(BlockSchema)),
	columnKey: Type.Optional(Type.String()),
	category: Type.Optional(Type.String()),
	sprintId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	milestoneId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	assigneeIds: Type.Optional(Type.Array(Type.String())),
	assigneeGroupIds: Type.Optional(Type.Array(Type.String())),
	priority: Type.Optional(IssuePrioritySchema),
	storyPoints: Type.Optional(Type.Number()),
	customFields: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	linkedIssues: Type.Optional(Type.Array(IssueLinkSchema)),
});

export const UpdateIssueBody = Type.Partial(
	Type.Object({
		title: Type.String({ minLength: 1 }),
		description: Type.Array(BlockSchema),
		columnKey: Type.String(),
		category: Type.String(),
		sprintId: Type.Union([Type.String(), Type.Null()]),
		milestoneId: Type.Union([Type.String(), Type.Null()]),
		assigneeIds: Type.Array(Type.String()),
		assigneeGroupIds: Type.Array(Type.String()),
		priority: IssuePrioritySchema,
		storyPoints: Type.Number(),
		customFields: Type.Record(Type.String(), Type.Unknown()),
		linkedIssues: Type.Array(IssueLinkSchema),
		reason: Type.String({ description: "Motivo del cambio (se registra en el historial)" }),
	})
);

export const MoveIssueBody = Type.Object({
	columnKey: Type.String({ minLength: 1, description: "Key de la columna destino" }),
	reason: Type.Optional(Type.String()),
	commentBlocks: Type.Optional(Type.Array(BlockSchema, { description: "Comentario de transición (obligatorio si el proyecto lo exige)" })),
	commentAttachmentIds: Type.Optional(Type.Array(Type.String())),
});
