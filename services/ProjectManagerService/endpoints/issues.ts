import { RegisterEndpoint, type EndpointCtx } from "@services/core/EndpointManagerService/index.js";
import { ProjectManagerError } from "@common/types/custom-errors/ProjectManagerError.ts";
import type ProjectManagerService from "../index.js";
import type { Issue } from "@common/types/project-manager/Issue.ts";
import type { IssueListFilters } from "../dao/issues.ts";
import type { Block } from "@common/ADC/types/learning.ts";
import { buildIssueResourceCtx } from "./utils/issueResourceCtx.ts";
import { assertCommentForFinalTransition } from "./utils/transitionGuards.ts";
import { validateAndSanitizeIssueDescription } from "./utils/validateIssueDescription.ts";
import { attachAssigneeProfiles } from "./utils/assigneeProfiles.ts";
import * as IS from "./schemas/issues.js";
import { IdParams, ProjectIdParams, OkResponse } from "./schemas/common.js";

const ISSUE_CREATE_RATE_LIMIT = { max: 20, timeWindow: 60_000 };
const ISSUE_UPDATE_RATE_LIMIT = { max: 20, timeWindow: 60_000 };
const ISSUE_DELETE_RATE_LIMIT = { max: 5, timeWindow: 60_000 };
const ISSUE_MOVE_RATE_LIMIT = { max: 20, timeWindow: 60_000 };

export class IssueEndpoints {
	private static service: ProjectManagerService;
	private static kernelKey: symbol;
	static init(service: ProjectManagerService, kernelKey: symbol): void {
		IssueEndpoints.service ??= service;
		IssueEndpoints.kernelKey ??= kernelKey;
	}

	@RegisterEndpoint({
		method: "GET",
		url: "/api/pm/projects/:projectId/issues",
		deferAuth: true,
		options: {
			tag: "ProjectManagerService/Issues",
			summary: "Lista los issues de un proyecto",
			description: "Admite filtros por sprint, milestone, assignee, columna, texto (`q`) y orden (`orderBy`). Devuelve los issues con perfiles de assignees hidratados y el proyecto.",
			schema: { params: ProjectIdParams, querystring: IS.ListIssuesQuery, response: { 200: IS.IssuesListResponse } },
		},
	})
	static async list(ctx: EndpointCtx<{ projectId: string }>) {
		const service = IssueEndpoints.service;
		const caller = await service.resolveCaller(IssueEndpoints.kernelKey, ctx);
		const project = await service.projects.getProject(ctx.params.projectId, ctx.token ?? undefined, caller);
		if (!project) throw new ProjectManagerError(404, "PROJECT_NOT_FOUND", "Proyecto no encontrado");

		const filters: IssueListFilters = {
			sprintId: ctx.query.sprintId || undefined,
			milestoneId: ctx.query.milestoneId || undefined,
			assigneeId: ctx.query.assigneeId || undefined,
			columnKey: ctx.query.columnKey || undefined,
			q: ctx.query.q || undefined,
			orderBy: (ctx.query.orderBy as IssueListFilters["orderBy"]) || undefined,
		};

		const issues = await service.issues.list(project, filters, ctx.token ?? undefined, caller);
		await attachAssigneeProfiles(service, issues);
		return { issues, project };
	}

	@RegisterEndpoint({
		method: "POST",
		url: "/api/pm/projects/:projectId/issues",
		deferAuth: true,
		options: {
			successStatus: 201,
			rateLimit: ISSUE_CREATE_RATE_LIMIT,
			tag: "ProjectManagerService/Issues",
			summary: "Crea un issue en el proyecto",
			schema: { params: ProjectIdParams, body: IS.CreateIssueBody, response: { 201: IS.IssueResponse } },
		},
	})
	static async create(ctx: EndpointCtx<{ projectId: string }, Partial<Issue> & { title: string }>) {
		if (!ctx.data?.title) throw new ProjectManagerError(400, "MISSING_FIELDS", "`title` es requerido");
		const service = IssueEndpoints.service;
		const caller = await service.resolveCaller(IssueEndpoints.kernelKey, ctx);
		const project = await service.projects.getProject(ctx.params.projectId, ctx.token ?? undefined, caller);
		if (!project) throw new ProjectManagerError(404, "PROJECT_NOT_FOUND", "Proyecto no encontrado");
		const data = { ...ctx.data };
		// Validar adjuntos referenciados en la descripción con el mismo criterio
		// que comments (ownership + permiso). En `create` el issue aún no existe,
		// así que evaluamos el contexto contra el proyecto + un issue "sintético".
		if (Array.isArray(data.description) && data.description.length) {
			const pmCtx = await service.buildPMCtx(IssueEndpoints.kernelKey, ctx);
			const syntheticAttachmentCtx = {
				userId: ctx.user?.id ?? "",
				tokenOrgId: ctx.user?.orgId ?? null,
				project,
				issue: { reporterId: ctx.user?.id ?? "", assigneeIds: [], assigneeGroupIds: [] } as unknown as Issue,
				pmCtx,
			};
			data.description = await validateAndSanitizeIssueDescription(service, syntheticAttachmentCtx, data.description);
		}
		const issue = await service.issues.create(project, data, ctx.token ?? undefined, caller);
		if (caller.userId) {
			await service.issueDescriptionDrafts
				.delete(caller.userId, { targetType: "pm-issue-description", targetId: issue.id })
				.catch(() => undefined);
		}
		// Avisos (fire-and-forget): asignados + mencionados en la descripción.
		void service.notifications(IssueEndpoints.kernelKey).issueAssigned(issue, caller.userId);
		void service.notifications(IssueEndpoints.kernelKey).issueMentions(issue, data.description, caller.userId);
		return await attachAssigneeProfiles(service, issue);
	}

	@RegisterEndpoint({
		method: "GET",
		url: "/api/pm/issues/:id",
		deferAuth: true,
		options: {
			tag: "ProjectManagerService/Issues",
			summary: "Obtiene un issue por ID",
			schema: { params: IdParams, response: { 200: IS.IssueResponse } },
		},
	})
	static async get(ctx: EndpointCtx<{ id: string }>) {
		const service = IssueEndpoints.service;
		const caller = await service.resolveCaller(IssueEndpoints.kernelKey, ctx);
		const issue = await service.issues.get(ctx.params.id, ctx.token ?? undefined, caller);
		if (!issue) throw new ProjectManagerError(404, "ISSUE_NOT_FOUND", "Issue no encontrado");
		return await attachAssigneeProfiles(service, issue);
	}

	@RegisterEndpoint({
		method: "PUT",
		url: "/api/pm/issues/:id",
		deferAuth: true,
		options: {
			rateLimit: ISSUE_UPDATE_RATE_LIMIT,
			tag: "ProjectManagerService/Issues",
			summary: "Actualiza un issue",
			description: "`reason` se registra en el historial. Al editar `description` se validan los adjuntos referenciados.",
			schema: { params: IdParams, body: IS.UpdateIssueBody, response: { 200: IS.IssueResponse } },
		},
	})
	static async update(ctx: EndpointCtx<{ id: string }, Partial<Issue> & { reason?: string }>) {
		const service = IssueEndpoints.service;
		const caller = await service.resolveCaller(IssueEndpoints.kernelKey, ctx);
		const { reason, ...updates } = ctx.data ?? {};
		// Si se actualiza la descripción, validar adjuntos contra el contexto real
		// del issue (project + issue resueltos).
		if (Array.isArray(updates.description)) {
			const built = await buildIssueResourceCtx(service, IssueEndpoints.kernelKey, ctx, { requireAuth: true });
			updates.description = await validateAndSanitizeIssueDescription(service, built.attachmentCtx, updates.description);
		}
		const updated = await service.issues.update(ctx.params.id, updates, reason, ctx.token ?? undefined, caller);
		if (caller.userId && updates.description !== undefined) {
			await service.issueDescriptionDrafts
				.delete(caller.userId, { targetType: "pm-issue-description", targetId: updated.id })
				.catch(() => undefined);
		}
		// Solo si cambió el estado/columna (no en cada edición): aviso a los participantes.
		if (updates.columnKey !== undefined) void service.notifications(IssueEndpoints.kernelKey).issueStatusChanged(updated, caller.userId);
		// Mencionados en la descripción editada.
		if (updates.description !== undefined)
			void service.notifications(IssueEndpoints.kernelKey).issueMentions(updated, updates.description, caller.userId);
		return await attachAssigneeProfiles(service, updated);
	}

	@RegisterEndpoint({
		method: "DELETE",
		url: "/api/pm/issues/:id",
		deferAuth: true,
		options: {
			rateLimit: ISSUE_DELETE_RATE_LIMIT,
			tag: "ProjectManagerService/Issues",
			summary: "Elimina un issue",
			schema: { params: IdParams, response: { 200: OkResponse } },
		},
	})
	static async delete(ctx: EndpointCtx<{ id: string }>) {
		const service = IssueEndpoints.service;
		const caller = await service.resolveCaller(IssueEndpoints.kernelKey, ctx);
		await service.issues.delete(ctx.params.id, ctx.token ?? undefined, caller);
		return { ok: true };
	}

	@RegisterEndpoint({
		method: "POST",
		url: "/api/pm/issues/:id/move",
		deferAuth: true,
		options: {
			rateLimit: ISSUE_MOVE_RATE_LIMIT,
			tag: "ProjectManagerService/Issues",
			summary: "Mueve un issue a otra columna",
			description: "Si el proyecto exige comentario en la transición final, `commentBlocks` es obligatorio. El comentario se guarda con `label = \"transition-reason\"`.",
			schema: { params: IdParams, body: IS.MoveIssueBody, response: { 200: IS.IssueResponse } },
		},
	})
	static async move(
		ctx: EndpointCtx<{ id: string }, { columnKey: string; reason?: string; commentBlocks?: Block[]; commentAttachmentIds?: string[] }>
	) {
		if (!ctx.data?.columnKey) throw new ProjectManagerError(400, "MISSING_FIELDS", "`columnKey` es requerido");
		const service = IssueEndpoints.service;
		const kernelKey = IssueEndpoints.kernelKey;
		const caller = await service.resolveCaller(kernelKey, ctx);

		// Pre-resolución para validar la transición y comprobar el flag del proyecto
		// antes de mover el issue.
		const pre = await buildIssueResourceCtx(service, kernelKey, ctx, { requireAuth: true });
		const commentBlocks = ctx.data.commentBlocks;
		assertCommentForFinalTransition(pre.project, ctx.data.columnKey, commentBlocks);

		const updated = await service.issues.move(ctx.params.id, ctx.data.columnKey, ctx.data.reason, ctx.token ?? undefined, caller);

		// Si se proporcionó un comentario (obligatorio o no), se persiste con
		// `label = "transition-reason"` para destacarlo en el historial.
		if (commentBlocks?.length) {
			try {
				await service.issueComments.create(pre.commentCtx, {
					targetType: "pm-issue",
					targetId: updated.id,
					blocks: commentBlocks,
					attachmentIds: ctx.data.commentAttachmentIds,
					label: "transition-reason",
					meta: {
						fromColumn: pre.issue.columnKey,
						toColumn: updated.columnKey,
						reason: ctx.data.reason,
					},
				});
			} catch (e) {
				console.warn(`[ProjectManager] Move OK pero falló el comentario de transición: ${(e as Error).message}`);
			}
		}

		// Cambio de estado/columna: aviso a los participantes (fire-and-forget).
		void service.notifications(IssueEndpoints.kernelKey).issueStatusChanged(updated, caller.userId);
		return await attachAssigneeProfiles(service, updated);
	}

	@RegisterEndpoint({
		method: "GET",
		url: "/api/pm/issues/:id/history",
		deferAuth: true,
		options: {
			tag: "ProjectManagerService/Issues",
			summary: "Obtiene el historial de cambios de un issue",
			schema: { params: IdParams, response: { 200: IS.IssueHistoryResponse } },
		},
	})
	static async history(ctx: EndpointCtx<{ id: string }>) {
		const service = IssueEndpoints.service;
		const caller = await service.resolveCaller(IssueEndpoints.kernelKey, ctx);
		const issue = await service.issues.get(ctx.params.id, ctx.token ?? undefined, caller);
		if (!issue) throw new ProjectManagerError(404, "ISSUE_NOT_FOUND", "Issue no encontrado");
		return { updateLog: issue.updateLog };
	}
}
