import { RegisterEndpoint, type EndpointCtx } from "@services/core/EndpointManagerService/index.js";
import { ProjectManagerError } from "@common/types/custom-errors/ProjectManagerError.ts";
import { AuthorizationError } from "@common/types/custom-errors/AuthorizationError.ts";
import type ProjectManagerService from "../index.js";
import type { Block } from "@common/ADC/types/learning.ts";
import { buildIssueResourceCtx } from "./utils/issueResourceCtx.ts";
import { validateAndSanitizeIssueDescription, ISSUE_DESCRIPTION_MAX_ATTACHMENTS } from "./utils/validateIssueDescription.ts";
import { isProjectAccessibleInOrgContext } from "../utils/project-access.ts";
import * as DS from "./schemas/issueDescription.js";
import { IdParams, OkResponse } from "./schemas/common.js";

const DRAFT_RATE_LIMIT = { max: 60, timeWindow: 60_000 };
const DRAFT_TARGET_TYPE = "pm-issue-description";

interface SaveDescriptionDraftBody {
	blocks: Block[];
	attachmentIds?: string[];
}

/**
 * Determina si el caller puede editar la descripción del issue: mismo set de
 * sujetos que `IssueManager.update` (reporter / assignee directo o por grupo /
 * owner del proyecto / admin global o de la org). Bloquea si el proyecto es
 * org-scoped y el token no está en esa org.
 */
function canEditIssueDescription(commentCtx: Awaited<ReturnType<typeof buildIssueResourceCtx>>["commentCtx"]): boolean {
	const { project, issue, userId, tokenOrgId, pmCtx } = commentCtx;
	if (pmCtx.isGlobalAdmin || pmCtx.hasGlobalPMWrite) return true;
	if (!isProjectAccessibleInOrgContext(project, tokenOrgId)) return false;
	if (project.ownerId === userId) return true;
	if (issue.reporterId === userId) return true;
	if (issue.assigneeIds?.includes(userId)) return true;
	const groupIds = pmCtx.groupIds ?? [];
	if (issue.assigneeGroupIds?.some((gid) => groupIds.includes(gid))) return true;
	return false;
}

async function assertCanEditDescription(service: ProjectManagerService, kernelKey: symbol, ctx: EndpointCtx<{ id: string }, unknown>) {
	const built = await buildIssueResourceCtx(service, kernelKey, ctx, { requireAuth: true });
	let allowed = canEditIssueDescription(built.commentCtx);
	if (!allowed && built.project.orgId) {
		// admin/PM de la org se resuelve async — aplazar al chequeo extra.
		allowed = await built.commentCtx.pmCtx.isOrgAdminOrPM(built.project.orgId);
	}
	if (!allowed) throw new AuthorizationError("No tienes permiso para editar la descripción de este issue", "FORBIDDEN");
	return built;
}

export class IssueDescriptionEndpoints {
	private static service: ProjectManagerService;
	private static kernelKey: symbol;
	static init(service: ProjectManagerService, kernelKey: symbol): void {
		IssueDescriptionEndpoints.service ??= service;
		IssueDescriptionEndpoints.kernelKey ??= kernelKey;
	}

	@RegisterEndpoint({
		method: "GET",
		url: "/api/pm/issues/:id/description/draft",
		deferAuth: true,
		options: {
			rateLimit: DRAFT_RATE_LIMIT,
			tag: "ProjectManagerService/IssueDescription",
			summary: "Obtiene el borrador de descripción del issue",
			schema: { params: IdParams, response: { 200: DS.IssueDescriptionDraftResponse } },
		},
	})
	static async getDraft(ctx: EndpointCtx<{ id: string }>) {
		const svc = IssueDescriptionEndpoints.service;
		const built = await assertCanEditDescription(svc, IssueDescriptionEndpoints.kernelKey, ctx);
		const draft = await svc.issueDescriptionDrafts.get(built.commentCtx.userId, {
			targetType: DRAFT_TARGET_TYPE,
			targetId: built.issue.id,
		});
		return { draft };
	}

	@RegisterEndpoint({
		method: "PUT",
		url: "/api/pm/issues/:id/description/draft",
		deferAuth: true,
		options: {
			rateLimit: DRAFT_RATE_LIMIT,
			skipIdempotency: true,
			tag: "ProjectManagerService/IssueDescription",
			summary: "Guarda el borrador de descripción del issue",
			description: "Valida los adjuntos referenciados; limita a un máximo de adjuntos por descripción.",
			schema: { params: IdParams, body: DS.SaveDescriptionDraftBody, response: { 200: DS.IssueDescriptionDraftResponse } },
		},
	})
	static async saveDraft(ctx: EndpointCtx<{ id: string }, SaveDescriptionDraftBody>) {
		const svc = IssueDescriptionEndpoints.service;
		const built = await assertCanEditDescription(svc, IssueDescriptionEndpoints.kernelKey, ctx);

		const rawBlocks = ctx.data?.blocks;
		if (!Array.isArray(rawBlocks)) {
			throw new ProjectManagerError(400, "MISSING_FIELDS", "`blocks` es requerido");
		}
		const blocks = await validateAndSanitizeIssueDescription(svc, built.attachmentCtx, rawBlocks);
		const attachmentIds = Array.isArray(ctx.data?.attachmentIds) ? ctx.data.attachmentIds.slice(0, ISSUE_DESCRIPTION_MAX_ATTACHMENTS) : [];

		const draft = await svc.issueDescriptionDrafts.save(
			built.commentCtx.userId,
			{ targetType: DRAFT_TARGET_TYPE, targetId: built.issue.id },
			{ blocks, attachmentIds }
		);
		return { draft };
	}

	@RegisterEndpoint({
		method: "DELETE",
		url: "/api/pm/issues/:id/description/draft",
		deferAuth: true,
		options: {
			rateLimit: DRAFT_RATE_LIMIT,
			skipIdempotency: true,
			tag: "ProjectManagerService/IssueDescription",
			summary: "Elimina el borrador de descripción del issue",
			schema: { params: IdParams, response: { 200: OkResponse } },
		},
	})
	static async deleteDraft(ctx: EndpointCtx<{ id: string }>) {
		const svc = IssueDescriptionEndpoints.service;
		const built = await assertCanEditDescription(svc, IssueDescriptionEndpoints.kernelKey, ctx);
		await svc.issueDescriptionDrafts.delete(built.commentCtx.userId, {
			targetType: DRAFT_TARGET_TYPE,
			targetId: built.issue.id,
		});
		return { ok: true };
	}
}
