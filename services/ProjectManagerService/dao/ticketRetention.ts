import type { Model } from "mongoose";
import type { ILogger } from "@interfaces/utils/ILogger.js";
import type { IdleRunContext } from "@common/types/operations/IIdleOrchestrator.ts";
import type { Issue } from "@common/types/project-manager/Issue.ts";
import {
	MINOR_TICKET_MAX_OPEN_DAYS,
	SUPPORT_TICKET_RETENTION,
	type SupportTicketRetention,
	type SupportTicketType,
} from "@common/types/project-manager/SupportTicket.ts";
import { buildTicketAnonymizePatch, type TicketAnonymizeDoc } from "./supportTickets.ts";
import { purgeIssueChildren, type IssueChildrenPurgeDeps } from "../maintenance.ts";

const DAY_MS = 86_400_000;

/** Marca de avance por documento. Hace el barrido reanudable e idempotente. */
type RetentionStage = "anonymized" | "purged";

interface TicketRetentionConfig {
	/** Tickets que toca un lote en cada etapa. Acota el turno, no la cola. */
	docsPerBatch: number;
}

/** Ticket candidato, con lo que hace falta para decidir su plazo. */
interface RetentionCandidate extends TicketAnonymizeDoc {
	createdAt: Date;
	closedAt?: Date | null;
}

/**
 * Retención de tickets de soporte: anonimiza y luego purga según {@link SUPPORT_TICKET_RETENTION}.
 *
 * Existe porque la anonimización sólo corría en la cascada de baja de cuenta, que filtra por
 * `reportedByUserId`: los tickets anónimos (`data`, `minor`, `authority`) se escriben con ese campo
 * en `null` y por lo tanto no se borraban NUNCA.
 *
 * Es un barrido dirigido y no un índice TTL a propósito: los tickets son documentos de la colección
 * `issues`, compartida con el trabajo real de todos los proyectos. Un TTL ahí borraría issues
 * ajenos ante cualquier error de filtro. Por lo mismo toda consulta acá se acota al proyecto del
 * tablero de tickets y además exige `customFields.type === "support_ticket"`: el tipo lo escribe
 * sólo la plataforma (ver `utils/reserved-custom-fields.ts`), pero un barrido que borra no puede
 * depender de un único discriminador dentro de un blob. Las solicitudes de alta de organización
 * viven en la misma colección y `/privacy` las declara sin plazo fijo.
 */
export class TicketRetentionSweeper {
	/** Cacheado tras el primer turno útil: el proyecto del tablero no cambia de id. */
	#projectId: string | null = null;

	constructor(
		private readonly issueModel: Model<Issue>,
		private readonly children: IssueChildrenPurgeDeps,
		private readonly resolveProjectId: () => Promise<string | null>,
		private readonly kernelKey: symbol,
		private readonly config: TicketRetentionConfig,
		private readonly logger: ILogger
	) {}

	/**
	 * Un lote: primero anonimiza lo vencido, después purga lo que ya cumplió su plazo largo.
	 * Devuelve cuántos tickets tocó; `0` deja que el planificador espacie el trabajo.
	 */
	async runBatch(ctx: IdleRunContext): Promise<number> {
		this.#projectId ??= await this.resolveProjectId();
		// Sin tablero de tickets no hay nada que barrer, y barrer "todos los issues que digan ser
		// tickets" es justamente lo que este trabajo no debe hacer.
		if (!this.#projectId) return 0;
		const projectId = this.#projectId;

		const anonymized = await this.#anonymizeDue(ctx, projectId);
		if (ctx.signal.aborted) return anonymized;
		return anonymized + (await this.#purgeDue(ctx, projectId));
	}

	/** Etapa 1: borra los datos de contacto (y el cuerpo, si la política lo pide) y marca el avance. */
	async #anonymizeDue(ctx: IdleRunContext, projectId: string): Promise<number> {
		const docs = await this.issueModel
			.find(
				{ projectId, "customFields.type": "support_ticket", "customFields.retentionStage": null, $or: this.#dueClauses() },
				{ id: 1, title: 1, description: 1, customFields: 1, updateLog: 1, createdAt: 1, closedAt: 1 }
			)
			.limit(this.config.docsPerBatch)
			.lean<RetentionCandidate[]>();

		let done = 0;
		let failed = 0;
		for (const doc of docs) {
			if (ctx.signal.aborted) break;
			const policy = policyOf(doc);
			if (!policy) continue;
			try {
				await this.#anonymize(doc, policy);
				done++;
			} catch (e) {
				// Un ticket que no se deja escribir no puede frenar a los demás: el próximo turno lo
				// reintenta porque sigue sin marca de avance.
				failed++;
				this.logger.logDebug(`Retención de tickets: ${doc.id} no se pudo anonimizar (${(e as Error).message})`);
			}
		}
		if (failed > 0) this.logger.logWarn(`Retención de tickets: ${failed} ticket(s) no se pudieron anonimizar en este lote`);
		if (done > 0) this.logger.logInfo(`Retención de tickets: ${done} ticket(s) anonimizados`);
		return done;
	}

	/** Etapa 2: borra el ticket entero (con comentarios y adjuntos) de los tipos que sí caducan. */
	async #purgeDue(ctx: IdleRunContext, projectId: string): Promise<number> {
		const docs = await this.issueModel
			.find({ projectId, "customFields.type": "support_ticket", "customFields.purgeDueAt": { $lte: stamp() } }, { id: 1 })
			.limit(this.config.docsPerBatch)
			.lean<{ id: string }[]>();

		let done = 0;
		for (const doc of docs) {
			if (ctx.signal.aborted) break;
			// La marca va ANTES de tocar a los hijos: si el proceso cae a mitad, el ticket sigue
			// matcheando la consulta (conserva `purgeDueAt`) y el próximo lote lo retoma.
			await this.#mark(doc.id, "purged");
			await purgeIssueChildren(this.children, this.kernelKey, doc.id);
			try {
				await this.issueModel.deleteOne({ id: doc.id });
				done++;
			} catch (e) {
				this.logger.logWarn(`Retención de tickets: ${doc.id} no se pudo borrar (${(e as Error).message})`);
			}
		}
		if (done > 0) this.logger.logInfo(`Retención de tickets: ${done} ticket(s) purgados`);
		return done;
	}

	/**
	 * Una cláusula por tipo con su propio plazo, más la red de seguridad de `minor`: sin `closedAt`
	 * el reloj no arranca nunca, y un ticket que nadie cierra no debería sobrevivir por olvido.
	 */
	#dueClauses(): Record<string, unknown>[] {
		const now = Date.now();
		const clauses: Record<string, unknown>[] = Object.entries(SUPPORT_TICKET_RETENTION).map(([type, policy]) => ({
			"customFields.ticketType": type,
			closedAt: { $lte: new Date(now - policy.anonymizeAfterDays * DAY_MS) },
		}));
		clauses.push({
			"customFields.ticketType": "minor",
			closedAt: null,
			createdAt: { $lte: new Date(now - MINOR_TICKET_MAX_OPEN_DAYS * DAY_MS) },
		});
		return clauses;
	}

	/**
	 * Sin `runValidators`: el patch deja `reporterId: ""` y el schema lo marca requerido. `updateOne`
	 * saltea los validadores, que es justo lo que permite desvincular un ticket de su autor.
	 */
	async #anonymize(doc: RetentionCandidate, policy: SupportTicketRetention): Promise<void> {
		const patch = buildTicketAnonymizePatch(doc, { scrubBody: policy.scrubBody, keepPublicCredit: true });
		patch["customFields.retentionStage"] = "anonymized" satisfies RetentionStage;
		patch["customFields.retentionAt"] = stamp();
		if (policy.purgeAfterDays !== null) {
			patch["customFields.purgeDueAt"] = stamp(new Date(retentionBase(doc).getTime() + policy.purgeAfterDays * DAY_MS));
		}
		await this.issueModel.updateOne({ id: doc.id }, { $set: patch });
	}

	#mark(issueId: string, stage: RetentionStage): Promise<unknown> {
		return this.issueModel.updateOne({ id: issueId }, { $set: { "customFields.retentionStage": stage, "customFields.retentionAt": stamp() } });
	}
}

/**
 * Las marcas de retención van como ISO-8601 UTC y no como `Date`: viven en `customFields`, un blob
 * que el editor del tablero devuelve tal cual lo recibió por JSON, y ahí un `Date` vuelve
 * convertido en string. Como mongo compara por tipo, un `$lte` contra `Date` dejaría de matchear
 * ese documento para siempre y el ticket no se purgaría nunca. En string el formato es fijo, así
 * que la comparación lexicográfica es cronológica y sobrevive al ida y vuelta.
 */
function stamp(date: Date = new Date()): string {
	return date.toISOString();
}

/** Política del tipo del ticket; `null` si el documento trae un tipo desconocido (no se toca). */
function policyOf(doc: RetentionCandidate): SupportTicketRetention | null {
	const type = doc.customFields?.ticketType;
	if (typeof type !== "string") return null;
	return SUPPORT_TICKET_RETENTION[type as SupportTicketType] ?? null;
}

/**
 * Fecha desde la que corre el plazo largo. Para un `minor` que nadie cerró se usa el vencimiento del
 * tope de apertura: si se usara `createdAt` a secas, la purga caería antes que la anonimización.
 */
function retentionBase(doc: RetentionCandidate): Date {
	if (doc.closedAt) return new Date(doc.closedAt);
	return new Date(new Date(doc.createdAt).getTime() + MINOR_TICKET_MAX_OPEN_DAYS * DAY_MS);
}
