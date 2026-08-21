import type { EndpointCtx } from "@services/core/EndpointManagerService/index.js";
import { ProjectManagerError } from "@common/types/custom-errors/ProjectManagerError.ts";
import type ProjectManagerService from "../../index.js";
import type { Project } from "@common/types/project-manager/Project.ts";
import type { Issue } from "@common/types/project-manager/Issue.ts";
import type { IssueCommentEndpointCtx } from "../../permissions/issueComments.ts";
import type { IssueAttachmentEndpointCtx } from "../../permissions/issueAttachments.ts";
import { AuthError } from "@common/types/custom-errors/AuthError.ts";

/**
 * Construye el contexto enriquecido para llamadas al `CommentsManager` /
 * `AttachmentsManager` ligadas a un issue.
 *
 * Resuelve el issue y el proyecto, valida que existan y devuelve el `pmCtx`
 * + datos de autor para que los `permissionChecker` registrados puedan
 * decidir el acceso.
 *
 * Si `opts.requireAuth` es `true`, exige `ctx.user` y lanza 401 si falta.
 */
export async function buildIssueResourceCtx(
	service: ProjectManagerService,
	kernelKey: symbol,
	ctx: EndpointCtx<{ id?: string; issueId?: string }>,
	opts: { requireAuth?: boolean; rawIssueId?: string } = {}
): Promise<{
	project: Project;
	issue: Issue;
	commentCtx: IssueCommentEndpointCtx;
	attachmentCtx: IssueAttachmentEndpointCtx;
}> {
	const issueId = opts.rawIssueId ?? ctx.params.id ?? ctx.params.issueId;
	if (!issueId) throw new ProjectManagerError(400, "MISSING_FIELDS", "issueId requerido");

	if (opts.requireAuth && !ctx.user) {
		throw new AuthError(401, "UNAUTHORIZED", "Authentication required");
	}

	const pmCtx = await service.buildPMCtx(kernelKey, ctx);
	const issue = await service.issues.get(issueId, pmCtx, ctx.token ?? undefined);
	if (!issue) throw new ProjectManagerError(404, "ISSUE_NOT_FOUND", `Issue ${issueId} no encontrado`);

	// `grantedByIssue`: el acceso al issue ya se autorizó arriba (incluye al asignado que no
	// es miembro del tablero); acá el proyecto es sólo el contexto de ese issue.
	const project = await service.projects.getProject(issue.projectId, pmCtx, ctx.token ?? undefined, { grantedByIssue: true });
	if (!project) throw new ProjectManagerError(404, "PROJECT_NOT_FOUND", `Proyecto ${issue.projectId} no encontrado`);

	const userId = ctx.user?.id ?? "";
	const tokenOrgId = ctx.user?.orgId ?? null;
	const authorName = ctx.user?.username;
	const authorImage = ctx.user ? (ctx.user.avatar ?? null) : undefined;

	const base = {
		userId,
		tokenOrgId,
		project,
		issue,
		pmCtx,
	};
	const commentCtx: IssueCommentEndpointCtx = { ...base, authorName, authorImage };
	const attachmentCtx: IssueAttachmentEndpointCtx = base;
	return { project, issue, commentCtx, attachmentCtx };
}
