import { Type } from "@sinclair/typebox";
import { BlockSchema, AttachmentDto } from "./common.js";

/** Schemas TypeBox para los endpoints de comentarios de issues. */

// ── Params ───────────────────────────────────────────────────────────────

export const IdCommentParams = Type.Object({
	id: Type.String({ minLength: 1, description: "ID del issue" }),
	commentId: Type.String({ minLength: 1, description: "ID del comentario" }),
});

export const IdRootParams = Type.Object({
	id: Type.String({ minLength: 1, description: "ID del issue" }),
	rootId: Type.String({ minLength: 1, description: "ID del comentario raíz del hilo" }),
});

export const IdReactionParams = Type.Object({
	id: Type.String({ minLength: 1, description: "ID del issue" }),
	commentId: Type.String({ minLength: 1, description: "ID del comentario" }),
	emoji: Type.String({ minLength: 1, description: "Emoji (URL-encoded) de la reacción" }),
});

// ── Query ────────────────────────────────────────────────────────────────

export const ListCommentsQuery = Type.Object({
	cursor: Type.Optional(Type.String()),
	parentId: Type.Optional(Type.String({ description: "Omitir = flat; vacío/null = raíces; valor = replies de ese padre" })),
	limit: Type.Optional(Type.String()),
});

export const ThreadQuery = Type.Object({
	cursor: Type.Optional(Type.String()),
	limit: Type.Optional(Type.String()),
});

export const DraftQuery = Type.Object({
	parentId: Type.Optional(Type.String()),
	editingCommentId: Type.Optional(Type.String()),
});

// ── Body ─────────────────────────────────────────────────────────────────

export const CreateCommentBody = Type.Object({
	blocks: Type.Array(BlockSchema),
	parentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	attachmentIds: Type.Optional(Type.Array(Type.String())),
	label: Type.Optional(Type.String({ description: "Etiqueta del comentario (ej. transition-reason)" })),
});

export const UpdateCommentBody = Type.Object({
	blocks: Type.Array(BlockSchema),
	attachmentIds: Type.Optional(Type.Array(Type.String())),
});

export const DraftBody = Type.Object({
	blocks: Type.Array(BlockSchema),
	attachmentIds: Type.Optional(Type.Array(Type.String())),
	parentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	editingCommentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

// ── Responses ──────────────────────────────────────────────────────────────

export const CommentResponse = Type.Object({
	id: Type.String(),
	targetType: Type.String(),
	targetId: Type.String(),
	parentId: Type.Union([Type.String(), Type.Null()]),
	threadRootId: Type.Optional(Type.String()),
	depth: Type.Optional(Type.Integer()),
	authorId: Type.String(),
	authorName: Type.Optional(Type.String()),
	authorImage: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	blocks: Type.Array(BlockSchema),
	attachments: Type.Optional(Type.Array(AttachmentDto)),
	reactions: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String()))),
	replyCount: Type.Optional(Type.Integer()),
	label: Type.Optional(Type.String()),
	meta: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	createdAt: Type.String({ format: "date-time" }),
	updatedAt: Type.Optional(Type.String({ format: "date-time" })),
	edited: Type.Optional(Type.Boolean()),
	deleted: Type.Optional(Type.Boolean()),
});

export const CommentsPageResponse = Type.Object({
	items: Type.Array(CommentResponse),
	nextCursor: Type.Union([Type.String(), Type.Null()]),
});

export const CommentCountResponse = Type.Object({ total: Type.Integer() });

export const CommentDraftSchema = Type.Object({
	id: Type.String(),
	ownerId: Type.String(),
	targetType: Type.String(),
	targetId: Type.String(),
	parentId: Type.Union([Type.String(), Type.Null()]),
	editingCommentId: Type.Union([Type.String(), Type.Null()]),
	blocks: Type.Array(BlockSchema),
	attachmentIds: Type.Array(Type.String()),
	updatedAt: Type.String({ format: "date-time" }),
});

export const CommentDraftResponse = Type.Object({ draft: Type.Union([CommentDraftSchema, Type.Null()]) });
