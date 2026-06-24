import type { NotifyInput, NotificationTopic } from "@common/types/notifications/Notification.ts";
import type { Issue } from "@common/types/project-manager/Issue.ts";
import type { Block } from "@common/ADC/types/learning.js";
import { extractMentions } from "@common/utils/blocks/mentions.js";

/** Emisor desacoplado inyectado por el servicio (envuelve `BaseModule.emitNotification`). */
export type NotifyEmitter = (input: NotifyInput) => Promise<void>;

export interface NotifyManagerDeps {
	emit: NotifyEmitter;
	/** Ruta de app de un proyecto (`/:orgSlug/:projectSlug`) para enlazar la notificación. */
	projectPath: (projectId: string) => Promise<string>;
	/** IDs de admins de plataforma (resueltos tras el gate interno de Identity). */
	getAdminUserIds: () => Promise<string[]>;
	/** Ruta del tablero de solicitudes de organización (o `/` si no resuelve). */
	orgRequestsPath: () => string;
}

/**
 * Notificaciones de dominio de project-management. Mantiene `index.ts` como base
 * del servicio: la composición de notificaciones (destinatarios, topic, enlace) es
 * una feature aislada que sólo depende de un emisor best-effort (`emitNotification`)
 * y de unos pocos resolutores inyectados, no de los managers de datos.
 */
export class NotifyManager {
	readonly #emit: NotifyEmitter;
	readonly #projectPath: NotifyManagerDeps["projectPath"];
	readonly #getAdminUserIds: NotifyManagerDeps["getAdminUserIds"];
	readonly #orgRequestsPath: NotifyManagerDeps["orgRequestsPath"];

	constructor(deps: NotifyManagerDeps) {
		this.#emit = deps.emit;
		this.#projectPath = deps.projectPath;
		this.#getAdminUserIds = deps.getAdminUserIds;
		this.#orgRequestsPath = deps.orgRequestsPath;
	}

	/**
	 * Avisa a los asignados de un issue (topic `projects.assigned`), excluyendo a
	 * quien hizo la acción (no te notificás a vos misma/o). Best-effort y
	 * desacoplado: no afecta la creación/edición del issue.
	 */
	async issueAssigned(issue: Issue, actorUserId: string): Promise<void> {
		const recipients = (issue.assigneeIds ?? []).filter((id) => id && id !== actorUserId);
		await this.#emitToIssueRecipients(recipients, issue, "projects.assigned", `Te asignaron ${issue.key || issue.title}`, issue.title);
	}

	/** Avisa a los participantes (reporter + asignados) de un comentario nuevo (`projects.comment`). */
	async issueCommented(issue: Issue, actorUserId: string): Promise<void> {
		const recipients = this.#issueParticipants(issue, actorUserId);
		await this.#emitToIssueRecipients(recipients, issue, "projects.comment", `Nuevo comentario en ${issue.key || issue.title}`, issue.title);
	}

	/** Avisa a los usuarios **mencionados** (`@`) en los bloques de un comentario/descripción (`projects.mention`). */
	async issueMentions(issue: Issue, blocks: Block[] | undefined, actorUserId: string): Promise<void> {
		const recipients = extractMentions(blocks).filter((id) => id && id !== actorUserId);
		await this.#emitToIssueRecipients(recipients, issue, "projects.mention", `Te mencionaron en ${issue.key || issue.title}`, issue.title);
	}

	/** Avisa a los participantes de un cambio de estado/columna del issue (`projects.status`). */
	async issueStatusChanged(issue: Issue, actorUserId: string): Promise<void> {
		const recipients = this.#issueParticipants(issue, actorUserId);
		await this.#emitToIssueRecipients(recipients, issue, "projects.status", `${issue.key || issue.title} cambió de estado`, issue.title);
	}

	/**
	 * Avisa a los **administradores de plataforma** (rol global `Admin`) de una nueva
	 * solicitud de organización (`org.request_received`), excluyendo al solicitante.
	 */
	async orgRequestReceived(ticketId: string, ticketKey: string, requesterUserId: string): Promise<void> {
		const admins = await this.#getAdminUserIds().catch(() => [] as string[]);
		const recipients = admins.filter((id) => id && id !== requesterUserId);
		if (recipients.length === 0) return;
		// El ticket vive en el proyecto (global) de solicitudes: enlazamos a su tablero.
		const link = this.#orgRequestsPath();
		await Promise.all(
			recipients.map((userId) =>
				this.#emit({
					userId,
					topic: "org.request_received",
					title: "Nueva solicitud de organización",
					body: `La solicitud ${ticketKey} está pendiente de revisión.`,
					icon: "adc-icon-app-projects",
					linkApp: "projects",
					link,
					data: { ticketId, ticketKey },
				})
			)
		);
	}

	/** Participantes directos de un issue (reporter + asignados), sin duplicados ni el actor. */
	#issueParticipants(issue: Issue, actorUserId: string): string[] {
		const ids = new Set<string>([issue.reporterId, ...(issue.assigneeIds ?? [])]);
		ids.delete(actorUserId);
		return [...ids].filter(Boolean);
	}

	async #emitToIssueRecipients(recipients: string[], issue: Issue, topic: NotificationTopic, title: string, body: string): Promise<void> {
		if (recipients.length === 0) return;
		// El app de PM no tiene ruta por issue: enlazamos al tablero del proyecto
		// (`/:orgSlug/:projectSlug`); el `issueId` viaja en `data` para foco/anclaje.
		const link = await this.#projectPath(issue.projectId);
		await Promise.all(
			recipients.map((userId) =>
				this.#emit({
					userId,
					topic,
					title,
					body,
					icon: "adc-icon-app-projects",
					linkApp: "projects",
					link,
					data: { issueId: issue.id, projectId: issue.projectId, key: issue.key },
				})
			)
		);
	}
}
