import { RegisterEndpoint, type EndpointCtx } from "@services/core/EndpointManagerService/index.js";
import { ProjectManagerError } from "@common/types/custom-errors/ProjectManagerError.ts";
import type ProjectManagerService from "../index.js";
import type { Block } from "@common/ADC/types/learning.ts";
import type { CommentLabel, CommentsPage } from "@common/types/comments/Comment.ts";
import { buildIssueResourceCtx } from "./utils/issueResourceCtx.ts";
import * as CS from "./schemas/comments.js";
import { IdParams, OkResponse } from "./schemas/common.js";

const COMMENT_RATE_LIMIT = { max: 30, timeWindow: 60_000 };
const REACT_RATE_LIMIT = { max: 60, timeWindow: 60_000 };
const DRAFT_RATE_LIMIT = { max: 60, timeWindow: 60_000 };

/** Tipo de target estándar para issues del Project Manager. */
const TARGET_TYPE = "pm-issue";

interface CreateBody {
	blocks: Block[];
	parentId?: string | null;
	attachmentIds?: string[];
	label?: CommentLabel;
}

interface UpdateBody {
	blocks: Block[];
	attachmentIds?: string[];
}

interface DraftBody {
	blocks: Block[];
	attachmentIds?: string[];
	parentId?: string | null;
	editingCommentId?: string | null;
}

/**
 * Rehidrata autores con Identity en cada lectura. `authorImage` en comentarios
 * queda como snapshot histórico; para UI debe prevalecer la selección actual
 * del usuario (`default`, `custom`, `linked:*`, `none`).
 */
async function attachFreshAuthorProfiles(service: ProjectManagerService, page: CommentsPage): Promise<CommentsPage> {
	if (page.items.length === 0) return page;
	const authorIds = Array.from(new Set(page.items.map((c) => c.authorId).filter(Boolean)));
	if (authorIds.length === 0) return page;

	try {
		const profiles = await service.identity.users.getPublicProfiles(authorIds);
		for (const comment of page.items) {
			const profile = profiles.get(comment.authorId);
			if (!profile) continue;
			comment.authorName = profile.username ?? comment.authorName;
			comment.authorImage = profile.avatar;
		}
	} catch {
		// Identity no disponible: dejamos el snapshot persistido en el comentario.
	}

	return page;
}

/**
 * En creación sí necesitamos guardar un snapshot razonable del autor, pero no
 * queremos resolverlo en `verifyToken` para cada request de la plataforma.
 * Hacemos esta lectura sólo en el write de comentario, que es mucho menos
 * frecuente que validar tokens.
 */
async function attachFreshAuthorProfileToCtx(
	service: ProjectManagerService,
	commentCtx: { userId: string; authorName?: string; authorImage?: string | null }
) {
	if (!commentCtx.userId) return;
	try {
		const profiles = await service.identity.users.getPublicProfiles([commentCtx.userId]);
		const profile = profiles.get(commentCtx.userId);
		if (!profile) return;
		commentCtx.authorName = profile.username ?? commentCtx.authorName;
		commentCtx.authorImage = profile.avatar;
	} catch {
		// Identity no disponible: se conserva lo que venga de la sesión/token.
	}
}

export class IssueCommentsEndpoints {
	private static service: ProjectManagerService;
	private static kernelKey: symbol;

	static init(service: ProjectManagerService, kernelKey: symbol): void {
		IssueCommentsEndpoints.service ??= service;
		IssueCommentsEndpoints.kernelKey ??= kernelKey;
	}

	@RegisterEndpoint({
		method: "GET",
		url: "/api/pm/issues/:id/comments",
		deferAuth: true,
		options: {
			tag: "ProjectManagerService/Comments",
			summary: "Lista los comentarios de un issue",
			description: "Sin `parentId` devuelve todos en flat; `parentId` vacío/null = raíces; con valor = replies de ese padre.",
			schema: { params: IdParams, querystring: CS.ListCommentsQuery, response: { 200: CS.CommentsPageResponse } },
		},
	})
	static async list(ctx: EndpointCtx<{ id: string }>) {
		const svc = IssueCommentsEndpoints.service;
		const { issue, commentCtx } = await buildIssueResourceCtx(svc, IssueCommentsEndpoints.kernelKey, ctx);
		const cursor = ctx.query.cursor || null;
		// Si la query no especifica `parentId`, devolvemos todos los comentarios
		// del issue en flat (incluye replies bajo padres eliminados). El cliente
		// reconstruye el \u00e1rbol con `buildCommentsTree`. Si llega expl\u00edcitamente
		// (string vac\u00edo o "null") = solo ra\u00edces; otro valor = replies de ese padre.
		const parentId = ctx.query.parentId === undefined ? undefined : ctx.query.parentId || null;
		const limit = ctx.query.limit ? Number(ctx.query.limit) : undefined;
		const page = await svc.issueComments.list(commentCtx, {
			targetType: TARGET_TYPE,
			targetId: issue.id,
			parentId,
			cursor,
			limit,
		});
		return attachFreshAuthorProfiles(svc, page);
	}

	@RegisterEndpoint({
		method: "GET",
		url: "/api/pm/issues/:id/comments/threads/:rootId",
		deferAuth: true,
		options: {
			tag: "ProjectManagerService/Comments",
			summary: "Obtiene un hilo de comentarios",
			schema: { params: CS.IdRootParams, querystring: CS.ThreadQuery, response: { 200: CS.CommentsPageResponse } },
		},
	})
	static async thread(ctx: EndpointCtx<{ id: string; rootId: string }>) {
		const svc = IssueCommentsEndpoints.service;
		const { commentCtx } = await buildIssueResourceCtx(svc, IssueCommentsEndpoints.kernelKey, ctx);
		const cursor = ctx.query.cursor || null;
		const limit = ctx.query.limit ? Number(ctx.query.limit) : undefined;
		const page = await svc.issueComments.getThread(commentCtx, ctx.params.rootId, { cursor, limit });
		return attachFreshAuthorProfiles(svc, page);
	}

	@RegisterEndpoint({
		method: "GET",
		url: "/api/pm/issues/:id/comments/count",
		deferAuth: true,
		options: {
			tag: "ProjectManagerService/Comments",
			summary: "Cuenta los comentarios de un issue",
			schema: { params: IdParams, response: { 200: CS.CommentCountResponse } },
		},
	})
	static async count(ctx: EndpointCtx<{ id: string }>) {
		const svc = IssueCommentsEndpoints.service;
		const { issue, commentCtx } = await buildIssueResourceCtx(svc, IssueCommentsEndpoints.kernelKey, ctx);
		const total = await svc.issueComments.count(commentCtx, { targetType: TARGET_TYPE, targetId: issue.id });
		return { total };
	}

	@RegisterEndpoint({
		method: "POST",
		url: "/api/pm/issues/:id/comments",
		deferAuth: true,
		options: {
			successStatus: 201,
			rateLimit: COMMENT_RATE_LIMIT,
			tag: "ProjectManagerService/Comments",
			summary: "Crea un comentario en un issue",
			schema: { params: IdParams, body: CS.CreateCommentBody, response: { 201: CS.CommentResponse } },
		},
	})
	static async create(ctx: EndpointCtx<{ id: string }, CreateBody>) {
		if (!ctx.data?.blocks?.length) throw new ProjectManagerError(400, "MISSING_FIELDS", "`blocks` requerido");
		const svc = IssueCommentsEndpoints.service;
		const { issue, commentCtx } = await buildIssueResourceCtx(svc, IssueCommentsEndpoints.kernelKey, ctx, { requireAuth: true });
		await attachFreshAuthorProfileToCtx(svc, commentCtx);
		const comment = await svc.issueComments.create(commentCtx, {
			targetType: TARGET_TYPE,
			targetId: issue.id,
			parentId: ctx.data.parentId ?? null,
			blocks: ctx.data.blocks,
			attachmentIds: ctx.data.attachmentIds,
			label: ctx.data.label,
		});
		// Avisos (fire-and-forget): participantes del issue + usuarios mencionados.
		void svc.notifications(IssueCommentsEndpoints.kernelKey).issueCommented(issue, commentCtx.userId);
		void svc.notifications(IssueCommentsEndpoints.kernelKey).issueMentions(issue, ctx.data.blocks, commentCtx.userId);
		return comment;
	}

	@RegisterEndpoint({
		method: "PUT",
		url: "/api/pm/issues/:id/comments/:commentId",
		deferAuth: true,
		options: {
			rateLimit: COMMENT_RATE_LIMIT,
			tag: "ProjectManagerService/Comments",
			summary: "Edita un comentario",
			schema: { params: CS.IdCommentParams, body: CS.UpdateCommentBody, response: { 200: CS.CommentResponse } },
		},
	})
	static async update(ctx: EndpointCtx<{ id: string; commentId: string }, UpdateBody>) {
		if (!ctx.data?.blocks?.length) throw new ProjectManagerError(400, "MISSING_FIELDS", "`blocks` requerido");
		const svc = IssueCommentsEndpoints.service;
		const { commentCtx } = await buildIssueResourceCtx(svc, IssueCommentsEndpoints.kernelKey, ctx, { requireAuth: true });
		return svc.issueComments.update(commentCtx, ctx.params.commentId, {
			blocks: ctx.data.blocks,
			attachmentIds: ctx.data.attachmentIds,
		});
	}

	@RegisterEndpoint({
		method: "DELETE",
		url: "/api/pm/issues/:id/comments/:commentId",
		deferAuth: true,
		options: {
			rateLimit: COMMENT_RATE_LIMIT,
			tag: "ProjectManagerService/Comments",
			summary: "Elimina un comentario",
			schema: { params: CS.IdCommentParams, response: { 200: OkResponse } },
		},
	})
	static async delete(ctx: EndpointCtx<{ id: string; commentId: string }>) {
		const svc = IssueCommentsEndpoints.service;
		const { commentCtx } = await buildIssueResourceCtx(svc, IssueCommentsEndpoints.kernelKey, ctx, { requireAuth: true });
		await svc.issueComments.delete(commentCtx, ctx.params.commentId);
		return { ok: true };
	}

	@RegisterEndpoint({
		method: "POST",
		url: "/api/pm/issues/:id/comments/:commentId/reactions/:emoji",
		deferAuth: true,
		options: {
			rateLimit: REACT_RATE_LIMIT,
			tag: "ProjectManagerService/Comments",
			summary: "Reacciona a un comentario",
			schema: { params: CS.IdReactionParams },
		},
	})
	static async react(ctx: EndpointCtx<{ id: string; commentId: string; emoji: string }>) {
		const svc = IssueCommentsEndpoints.service;
		const { commentCtx } = await buildIssueResourceCtx(svc, IssueCommentsEndpoints.kernelKey, ctx, { requireAuth: true });
		const emoji = decodeURIComponent(ctx.params.emoji);
		return svc.issueComments.react(commentCtx, ctx.params.commentId, emoji);
	}

	@RegisterEndpoint({
		method: "DELETE",
		url: "/api/pm/issues/:id/comments/:commentId/reactions/:emoji",
		deferAuth: true,
		options: {
			rateLimit: REACT_RATE_LIMIT,
			tag: "ProjectManagerService/Comments",
			summary: "Quita una reacción de un comentario",
			schema: { params: CS.IdReactionParams },
		},
	})
	static async unreact(ctx: EndpointCtx<{ id: string; commentId: string; emoji: string }>) {
		const svc = IssueCommentsEndpoints.service;
		const { commentCtx } = await buildIssueResourceCtx(svc, IssueCommentsEndpoints.kernelKey, ctx, { requireAuth: true });
		const emoji = decodeURIComponent(ctx.params.emoji);
		return svc.issueComments.unreact(commentCtx, ctx.params.commentId, emoji);
	}

	@RegisterEndpoint({
		method: "GET",
		url: "/api/pm/issues/:id/comments/draft",
		deferAuth: true,
		options: {
			tag: "ProjectManagerService/Comments",
			summary: "Obtiene el borrador de comentario del usuario",
			schema: { params: IdParams, querystring: CS.DraftQuery, response: { 200: CS.CommentDraftResponse } },
		},
	})
	static async getDraft(ctx: EndpointCtx<{ id: string }>) {
		const svc = IssueCommentsEndpoints.service;
		const { issue, commentCtx } = await buildIssueResourceCtx(svc, IssueCommentsEndpoints.kernelKey, ctx, { requireAuth: true });
		const parentId = ctx.query.parentId === undefined ? null : ctx.query.parentId || null;
		const editingCommentId = ctx.query.editingCommentId === undefined ? null : ctx.query.editingCommentId || null;
		const draft = await svc.issueComments.getDraft(commentCtx, {
			targetType: TARGET_TYPE,
			targetId: issue.id,
			parentId,
			editingCommentId,
		});
		return { draft };
	}

	@RegisterEndpoint({
		method: "PUT",
		url: "/api/pm/issues/:id/comments/draft",
		deferAuth: true,
		options: {
			rateLimit: DRAFT_RATE_LIMIT,
			skipIdempotency: true,
			tag: "ProjectManagerService/Comments",
			summary: "Guarda el borrador de comentario",
			schema: { params: IdParams, body: CS.DraftBody, response: { 200: CS.CommentDraftSchema } },
		},
	})
	static async saveDraft(ctx: EndpointCtx<{ id: string }, DraftBody>) {
		if (!Array.isArray(ctx.data?.blocks)) throw new ProjectManagerError(400, "MISSING_FIELDS", "`blocks` requerido");
		const svc = IssueCommentsEndpoints.service;
		const { issue, commentCtx } = await buildIssueResourceCtx(svc, IssueCommentsEndpoints.kernelKey, ctx, { requireAuth: true });
		return svc.issueComments.saveDraft(
			commentCtx,
			{
				targetType: TARGET_TYPE,
				targetId: issue.id,
				parentId: ctx.data.parentId ?? null,
				editingCommentId: ctx.data.editingCommentId ?? null,
			},
			{ blocks: ctx.data.blocks, attachmentIds: ctx.data.attachmentIds }
		);
	}

	@RegisterEndpoint({
		method: "DELETE",
		url: "/api/pm/issues/:id/comments/draft",
		deferAuth: true,
		options: {
			skipIdempotency: true,
			tag: "ProjectManagerService/Comments",
			summary: "Elimina el borrador de comentario",
			schema: { params: IdParams, querystring: CS.DraftQuery, response: { 200: OkResponse } },
		},
	})
	static async deleteDraft(ctx: EndpointCtx<{ id: string }>) {
		const svc = IssueCommentsEndpoints.service;
		const { issue, commentCtx } = await buildIssueResourceCtx(svc, IssueCommentsEndpoints.kernelKey, ctx, { requireAuth: true });
		const parentId = ctx.query.parentId === undefined ? null : ctx.query.parentId || null;
		const editingCommentId = ctx.query.editingCommentId === undefined ? null : ctx.query.editingCommentId || null;
		await svc.issueComments.deleteDraft(commentCtx, {
			targetType: TARGET_TYPE,
			targetId: issue.id,
			parentId,
			editingCommentId,
		});
		return { ok: true };
	}
}
