import type { ILogger } from "@interfaces/utils/ILogger.js";
import type { AttachmentsManager } from "@utilities/attachments/attachments-utility/index.js";
import type { CommentsManager } from "@utilities/comments/comments-utility/index.js";
import type { ProjectManager, IssueManager, SprintManager, MilestoneManager, SupportTicketManager, OrganizationRequestManager } from "./dao/index.js";

/** Managers necesarios para purgar en cascada los datos privados de un usuario. */
export interface PMPurgeDeps {
	readonly projects: ProjectManager;
	readonly issues: IssueManager;
	readonly sprints: SprintManager;
	readonly milestones: MilestoneManager;
	readonly supportTickets: SupportTicketManager;
	readonly organizationRequests: OrganizationRequestManager;
	readonly comments: CommentsManager | null;
	readonly attachments: AttachmentsManager | null;
	readonly logger: ILogger;
}

/** Resultado de la purga: proyectos privados borrados y tickets anonimizados. */
export interface PMPurgeResult {
	readonly projects: number;
	readonly tickets: number;
	readonly orgRequests: number;
}

/** Lo mínimo para borrar los hijos de un issue; lo satisface `PMPurgeDeps` y el barrido de retención. */
export interface IssueChildrenPurgeDeps {
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
export async function purgeIssueChildren(deps: IssueChildrenPurgeDeps, kernelKey: symbol, issueId: string): Promise<void> {
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
 * Purga los datos de un usuario en PM: cascada de sus proyectos PRIVADOS con todo
 * su contenido (issues con adjuntos/comentarios, sprints, milestones) + anonimización
 * de sus tickets de soporte, que viven en un proyecto global y por eso no los
 * alcanza la cascada. Los adjuntos de lo que sobrevive anonimizado pierden su
 * `uploadedBy`: si no, un join por `ownerId` reconstruye al autor que se acaba de
 * desvincular. Tolera fallos por paso (loguea warnings y continúa).
 */
export async function purgeUserPMData(deps: PMPurgeDeps, kernelKey: symbol, userId: string): Promise<PMPurgeResult> {
	let projects = 0;
	const projectIds = await deps.projects.listPrivateProjectIdsByOwner(kernelKey, userId);
	if (projectIds.length > 0) {
		for (const projectId of projectIds) await purgeProjectCascade(deps, kernelKey, projectId);
		projects = await deps.projects.forceDeleteProjects(kernelKey, projectIds);
	}

	let tickets = 0;
	await purgeStep(deps.logger, "anonimización de tickets de soporte", async () => {
		tickets = await deps.supportTickets.anonymizeReporter(kernelKey, userId);
	});

	let orgRequests = 0;
	await purgeStep(deps.logger, "anonimización de solicitudes de organización", async () => {
		orgRequests = await deps.organizationRequests.anonymizeRequester(kernelKey, userId);
	});

	// Los adjuntos de los tickets anonimizados siguen existiendo (el ticket queda como constancia):
	// se les quita la única columna que todavía apuntaba a la persona.
	if (deps.attachments) {
		await purgeStep(deps.logger, "anonimización de adjuntos de PM", () => deps.attachments!.anonymizeByUploader(kernelKey, userId));
	}

	return { projects, tickets, orgRequests };
}
