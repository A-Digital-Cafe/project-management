import type { ILogger } from "@interfaces/utils/ILogger.js";
import type { AttachmentsManager } from "@utilities/attachments/attachments-utility/index.js";
import type { CommentsManager } from "@utilities/comments/comments-utility/index.js";
import type { ProjectManager, IssueManager, SprintManager, MilestoneManager } from "./dao/index.js";

/** Managers necesarios para purgar en cascada los datos privados de un usuario. */
export interface PMPurgeDeps {
	readonly projects: ProjectManager;
	readonly issues: IssueManager;
	readonly sprints: SprintManager;
	readonly milestones: MilestoneManager;
	readonly comments: CommentsManager | null;
	readonly attachments: AttachmentsManager | null;
	readonly logger: ILogger;
}

/** Ejecuta un paso de purga tolerando fallos (sólo loguea un warning y continúa). */
async function purgeStep(logger: ILogger, label: string, op: () => Promise<unknown>): Promise<void> {
	try {
		await op();
	} catch (e) {
		logger.logWarn(`Purga PM: ${label}: ${(e as Error).message}`);
	}
}

/** Borra los hijos de un issue: comentarios y adjuntos (si sus managers están disponibles). */
async function purgeIssueChildren(deps: PMPurgeDeps, kernelKey: symbol, issueId: string): Promise<void> {
	const { comments, attachments } = deps;
	if (comments) await purgeStep(deps.logger, `comentarios de issue ${issueId}`, () => comments.purgeByTarget(kernelKey, "pm-issue", issueId));
	if (attachments)
		await purgeStep(deps.logger, `adjuntos de issue ${issueId}`, () => attachments.forceDeleteByOwner(kernelKey, "pm-issue", issueId));
}

/** Cascada de borrado de un proyecto: issues (+ hijos), sprints y milestones. */
async function purgeProjectCascade(deps: PMPurgeDeps, kernelKey: symbol, projectId: string): Promise<void> {
	let issueIds: string[] = [];
	await purgeStep(deps.logger, `no se pudieron listar issues de ${projectId}`, async () => {
		issueIds = await deps.issues.listIssueIdsByProject(kernelKey, projectId);
	});
	for (const issueId of issueIds) await purgeIssueChildren(deps, kernelKey, issueId);
	await purgeStep(deps.logger, `cascada de ${projectId}`, async () => {
		await deps.issues.forceDeleteByProject(kernelKey, projectId);
		await deps.sprints.forceDeleteByProject(kernelKey, projectId);
		await deps.milestones.forceDeleteByProject(kernelKey, projectId);
	});
}

/**
 * Purga en cascada los proyectos PRIVADOS de un usuario y todo su contenido
 * (issues con adjuntos/comentarios, sprints, milestones). Tolera fallos por
 * proyecto/issue (loguea warnings y continúa).
 *
 * Devuelve el número de proyectos eliminados, o `null` si el usuario no tenía
 * proyectos privados (nada que purgar).
 */
export async function purgePrivateProjectData(deps: PMPurgeDeps, kernelKey: symbol, userId: string): Promise<number | null> {
	const projectIds = await deps.projects.listPrivateProjectIdsByOwner(kernelKey, userId);
	if (projectIds.length === 0) return null;

	for (const projectId of projectIds) await purgeProjectCascade(deps, kernelKey, projectId);

	return deps.projects.forceDeleteProjects(kernelKey, projectIds);
}
