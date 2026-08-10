import type { Model } from "mongoose";
import type { Block } from "@common/ADC/types/learning.ts";
import type { Issue } from "@common/types/project-manager/Issue.ts";
import type { UpdateLogEntry } from "@common/types/project-manager/UpdateLogEntry.ts";
import { ProjectManagerError } from "@common/types/custom-errors/ProjectManagerError.ts";
import {
	type CreateSupportTicketInput,
	type SupportTicketIssueResponse,
	type SupportTicketCaller,
	type SupportTicketConfig,
	TICKET_TYPE_LABELS,
	RETENTION_SCRUBBED_BODY,
	type OpenTicketEntry,
	type SupportTicketType,
} from "@common/types/project-manager/SupportTicket.ts";
import {
	TICKET_COLUMN_MAP,
	TICKET_TYPE_CATEGORIES,
	ensureTicketBoard,
	type AuthorityDecision,
	type AuthorityRequestType,
	type CommonTicketColumnKey,
} from "../boards.ts";
import type { ILogger } from "@interfaces/utils/ILogger.js";
import { generateId, safeEqualHex, sha256Hex } from "@common/utils/crypto.ts";
import type { CustomFieldValue } from "@common/types/project-manager/CustomField.ts";
import { deriveBugBountyStatus, type BugBountyPublicEntry } from "@common/types/project-manager/BugBounty.ts";
import type { IssueManager } from "./issues.js";
import type { ProjectManager } from "./projects.js";
import { redactLabeledParagraphs } from "./redact.ts";

/** Respuesta de creación + el código de revocación de crédito, que se muestra una sola vez. */
export interface SupportTicketCreateResult extends SupportTicketIssueResponse {
	/**
	 * Sólo en bug bounty con crédito aceptado. Es un secreto portador: la plataforma guarda
	 * únicamente su SHA-256, así que si se pierde no se puede reemitir (queda la vía manual).
	 */
	creditRevocationToken?: string;
}

/** Lo que decide el triage sobre un requerimiento de autoridad. Todo enumerado o contador. */
export interface AuthorityDecisionInput {
	decision: AuthorityDecision;
	requestType: AuthorityRequestType | null;
	/** Código o nombre corto de la jurisdicción (`AR`, `AR-CABA`, `US-CA`). Nunca la carátula. */
	jurisdiction: string | null;
	/** Si se notificó al titular de los datos alcanzados. */
	notifiedUser: boolean;
	/** Si la notificación quedó diferida por una prohibición legal de informar. */
	noticeDeferred: boolean;
	/** Cuántos elementos se entregaron (0 = no se entregó nada). */
	itemsDisclosed: number;
}

export class SupportTicketManager {
	constructor(
		private readonly projects: ProjectManager,
		private readonly issues: IssueManager,
		private readonly issueModel: Model<Issue>,
		private readonly kernelKey: symbol,
		private readonly logger: ILogger,
		private readonly config: SupportTicketConfig = {}
	) {}

	async create(kernelKey: symbol, input: CreateSupportTicketInput, caller: SupportTicketCaller): Promise<SupportTicketCreateResult> {
		this.#projectSlug(); // valida configuración antes de tocar la base.
		// Autogenera/reconcilia el tablero en la propia request: si falta el proyecto,
		// una columna o un campo canónico, el ticket no queda huérfano esperando al
		// próximo arranque del servicio.
		const project = await ensureTicketBoard({ projects: this.projects, logger: this.logger }, kernelKey, "tickets", this.config);
		if (!project) {
			throw new ProjectManagerError(
				503,
				"SUPPORT_TICKET_PROJECT_UNAVAILABLE",
				"El proyecto configurado para tickets de soporte no existe"
			);
		}

		// Asignar columna según el tipo de ticket (tipada)
		const columnKey: CommonTicketColumnKey = TICKET_COLUMN_MAP[input.type];

		// El crédito público es un consentimiento y tiene que poder retirarse sin cuenta: se emite
		// acá el único portador que lo permite y se persiste sólo su hash.
		const creditToken = input.type === "security" && input.wantsCredit === true ? generateId() : null;

		const issue = await this.issues.createInternal(
			kernelKey,
			project,
			{
				title: `[${TICKET_TYPE_LABELS[input.type]}] ${input.title}`,
				description: supportTicketBlocks(input, caller),
				category: TICKET_TYPE_CATEGORIES[input.type],
				columnKey,
				customFields: supportTicketCustomFields(input, caller, creditToken),
			},
			caller.userId ?? ""
		);

		return {
			ticketId: issue.id,
			ticketKey: issue.key,
			message: `Ticket creado. El ID es ${issue.key}.`,
			...(creditToken ? { creditRevocationToken: creditToken } : {}),
		};
	}

	/**
	 * Retira el consentimiento de atribución de un reporte de bug bounty: el log público pasa a
	 * mostrar la entrada sin handle, conservando `descriptionHash`, la descripción divulgada y el
	 * hallazgo. Borrar la entrada sería reescribir un log de transparencia; anonimizarla, no.
	 *
	 * La prueba es el código emitido al reportar (comparado por su hash, en tiempo constante):
	 * quien reportó puede no tener cuenta, así que no hay sesión que valga como identidad.
	 * Idempotente hacia afuera: una vez revocado el código deja de existir y el resultado es `false`.
	 */
	async revokeBugBountyCredit(kernelKey: symbol, ticketKey: string, token: string): Promise<boolean> {
		if (kernelKey !== this.kernelKey) throw new Error("Acceso denegado: kernel key inválida");
		if (!ticketKey || !token) return false;

		const slug = this.#projectSlug();
		const project = await this.projects.getInternals(kernelKey).fetchGlobalProjectBySlug(slug);
		if (!project) return false;

		const doc = await this.issueModel
			.findOne({ projectId: project.id, key: ticketKey, "customFields.bugBounty": "true" }, { id: 1, customFields: 1 })
			.lean<{ id: string; customFields?: Record<string, unknown> } | null>();
		const stored = doc?.customFields?.creditRevocationHash;
		if (!doc || typeof stored !== "string" || !safeEqualHex(sha256Hex(token), stored)) return false;

		await this.issueModel.updateOne(
			{ id: doc.id },
			{
				$set: {
					updatedAt: new Date(),
					"customFields.wantsCredit": "false",
					"customFields.creditName": null,
					// Sin handle que retirar, el vínculo con la cuenta que lo sostenía deja de tener razón
					// de ser (lo escribe la anonimización por retención; ver `buildTicketAnonymizePatch`).
					"customFields.creditOwnerUserId": null,
					// El código muere con el uso: sin hash guardado ya no valida contra nada.
					"customFields.creditRevocationHash": null,
					"customFields.creditRevokedAt": new Date().toISOString(),
				},
			}
		);
		this.logger.logInfo(`Bug bounty ${ticketKey}: crédito público revocado por quien reportó`);
		return true;
	}

	/**
	 * Asienta en el ticket la decisión sobre un requerimiento de autoridad. El registro auditable
	 * es el audit log; esto deja la misma información en el tablero, que es donde se tría.
	 * Devuelve `false` si la clave no corresponde a un ticket de autoridades.
	 */
	async recordAuthorityDecision(kernelKey: symbol, ticketKey: string, input: AuthorityDecisionInput): Promise<boolean> {
		if (kernelKey !== this.kernelKey) throw new Error("Acceso denegado: kernel key inválida");
		if (!ticketKey) return false;

		const slug = this.#projectSlug();
		const project = await this.projects.getInternals(kernelKey).fetchGlobalProjectBySlug(slug);
		if (!project) return false;

		const res = await this.issueModel.updateOne(
			{ projectId: project.id, key: ticketKey, "customFields.ticketType": "authority" },
			{
				$set: {
					updatedAt: new Date(),
					"customFields.authorityDecision": input.decision,
					"customFields.authorityRequestType": input.requestType,
					"customFields.authorityJurisdiction": input.jurisdiction,
					"customFields.authorityNotifiedUser": input.notifiedUser ? "true" : "false",
					"customFields.authorityNoticeDeferred": input.noticeDeferred ? "true" : "false",
					"customFields.authorityItemsDisclosed": input.itemsDisclosed,
					"customFields.authorityDecidedAt": new Date().toISOString(),
				},
			}
		);
		return (res.matchedCount ?? 0) > 0;
	}

	/**
	 * Tickets abiertos (columna sin `isDone`) de un tipo, para las colas de moderación de otros
	 * módulos. Devuelve lo mínimo para triar —clave, título, fecha y descripción en texto— y **no**
	 * el email de quien reportó: la cola sirve para actuar sobre el contenido, no para saber quién
	 * denunció.
	 */
	async listOpenByType(kernelKey: symbol, type: SupportTicketType, limit = 100): Promise<OpenTicketEntry[]> {
		const slug = this.#projectSlug();
		const project = await this.projects.getInternals(kernelKey).fetchGlobalProjectBySlug(slug);
		if (!project) return [];

		const openColumns = project.kanbanColumns.filter((c) => !c.isDone).map((c) => c.key);
		const issues = await this.issues.listOpenSupportTicketsInternal(kernelKey, project.id, type, openColumns, limit);

		return issues.map((issue) => ({
			ticketKey: issue.key,
			title: issue.title,
			createdAt: issue.createdAt.toISOString(),
			columnKey: issue.columnKey,
			description: plainTextFromBlocks(issue.description),
		}));
	}

	/**
	 * Log público de transparencia del bug bounty. Sin auth: id, fecha/hora, hash,
	 * estado y severidad son siempre públicos. La **descripción original** solo se
	 * publica si el ticket está `resolved` y el reporter pidió divulgación
	 * (`publicDisclosure === "true"`); el **handle** además exige `wantsCredit`.
	 */
	async listPublicBugBounty(kernelKey: symbol): Promise<BugBountyPublicEntry[]> {
		const slug = this.#projectSlug();
		const project = await this.projects.getInternals(kernelKey).fetchGlobalProjectBySlug(slug);
		if (!project) return [];

		const columnName = new Map(project.kanbanColumns.map((c) => [c.key, c.name]));
		const issues = await this.issues.listBugBountyInternal(kernelKey, project.id);

		return issues.map((issue) => {
			const cf = issue.customFields ?? {};
			// El estado se deriva de la columna actual del ticket en el tablero del PM.
			const status = deriveBugBountyStatus(issue.columnKey, columnName.get(issue.columnKey));
			const disclosed = cf.publicDisclosure === "true";
			const wantsCredit = cf.wantsCredit === "true";
			// Publicar los pasos de reproducción antes del fix sería divulgar un 0-day:
			// la descripción sale sólo con el ticket resuelto Y consentimiento explícito.
			// El hash, en cambio, no revela nada y es la prueba de no-manipulación.
			const published = status === "resolved" && disclosed;
			const reportedAt = typeof cf.reportedAt === "string" ? cf.reportedAt : issue.createdAt.toISOString();
			// Sólo se publica junto al estado `duplicate`: fuera de esa columna el campo
			// puede haber quedado de un triage anterior y afirmaría algo que ya no es.
			const duplicateOf = status === "duplicate" && typeof cf.duplicateOf === "string" ? cf.duplicateOf.trim() || null : null;

			return {
				ticketKey: issue.key,
				reportedAt,
				descriptionHash: typeof cf.descriptionHash === "string" ? cf.descriptionHash : "",
				status,
				duplicateOf,
				severity: (cf.severity as BugBountyPublicEntry["severity"]) ?? null,
				creditHandle: disclosed && wantsCredit && typeof cf.creditName === "string" ? cf.creditName : null,
				description: published && typeof cf.originalDescription === "string" ? cf.originalDescription : null,
			};
		});
	}

	/**
	 * Tickets abiertos por un usuario para el export de sus datos: clave, tipo, título, estado,
	 * fechas y descripción en texto, sin campos de triage internos. Protegido por `kernelKey`.
	 */
	async listByReporter(kernelKey: symbol, userId: string, limit = 500): Promise<Array<Record<string, unknown>>> {
		if (kernelKey !== this.kernelKey) throw new Error("Acceso denegado: kernel key inválida");
		if (!userId) return [];

		const docs = await this.issueModel
			.find(
				{ "customFields.type": "support_ticket", "customFields.reportedByUserId": userId },
				{ key: 1, title: 1, columnKey: 1, createdAt: 1, updatedAt: 1, description: 1, "customFields.ticketType": 1 }
			)
			.sort({ createdAt: -1 })
			.limit(limit)
			.lean<Array<Pick<Issue, "key" | "title" | "columnKey" | "createdAt" | "updatedAt" | "description"> & { customFields?: Record<string, unknown> }>>();

		return docs.map((doc) => ({
			ticketKey: doc.key,
			type: typeof doc.customFields?.ticketType === "string" ? doc.customFields.ticketType : null,
			title: doc.title,
			columnKey: doc.columnKey,
			description: plainTextFromBlocks(doc.description),
			createdAt: doc.createdAt,
			updatedAt: doc.updatedAt,
		}));
	}

	/**
	 * Desvincula de un usuario los tickets que abrió (purga de cuenta). Los tickets
	 * viven en un proyecto global, así que no los alcanza la cascada de proyectos
	 * privados: hay que anonimizarlos acá. Se conserva el ticket (contenido
	 * operativo del soporte) y su hash; se borran los emails, el vínculo con el
	 * usuario y el handle de crédito — el consentimiento de atribución muere con
	 * la cuenta. Uso interno, protegido por `kernelKey`.
	 */
	async anonymizeReporter(kernelKey: symbol, userId: string): Promise<number> {
		if (kernelKey !== this.kernelKey) throw new Error("Acceso denegado: kernel key inválida");
		if (!userId) return 0;

		const docs = await this.issueModel
			.find(
				{
					"customFields.type": "support_ticket",
					// El barrido de retención ya borró `reportedByUserId` de los tickets vencidos: los que
					// conservaron el crédito público sólo se encuentran por `creditOwnerUserId`.
					$or: [{ "customFields.reportedByUserId": userId }, { "customFields.creditOwnerUserId": userId }],
				},
				{ id: 1, title: 1, description: 1, customFields: 1, updateLog: 1 }
			)
			.lean<TicketAnonymizeDoc[]>();

		for (const doc of docs) {
			await this.issueModel.updateOne({ id: doc.id }, { $set: buildTicketAnonymizePatch(doc) });
		}

		return docs.length;
	}

	/**
	 * Id del proyecto que aloja los tickets, o `null` si no hay slug configurado o el tablero todavía
	 * no se creó. Lo consume el barrido de retención, que tiene que acotarse a ese proyecto porque
	 * `issues` es la colección de TODOS los tableros. Uso interno, protegido por `kernelKey`.
	 */
	async ticketsProjectId(kernelKey: symbol): Promise<string | null> {
		if (kernelKey !== this.kernelKey) throw new Error("Acceso denegado: kernel key inválida");
		const slug = this.#configuredSlug();
		if (!slug) return null;
		const project = await this.projects.getInternals(kernelKey).fetchGlobalProjectBySlug(slug);
		return project?.id ?? null;
	}

	#configuredSlug(): string {
		return this.config.supportTicketsProjectId?.trim() || this.config.orgManagementProjectId?.trim() || "";
	}

	#projectSlug(): string {
		const slug = this.#configuredSlug();

		if (!slug) {
			throw new ProjectManagerError(
				503,
				"SUPPORT_TICKET_PROJECT_NOT_CONFIGURED",
				"Falta configurar PM_SUPPORT_TICKETS_PROJECT_ID o ORG_MANAGEMENT_PROJECT_ID (slug del proyecto) para crear tickets de soporte"
			);
		}
		return slug;
	}
}

/**
 * Etiquetas de los párrafos que llevan datos personales del reporter. Se generan
 * y se redactan por acá: si cambia una, la purga tiene que seguir encontrándola.
 */
const REPORTER_LABELS = {
	contactEmail: "Email de contacto",
	reporterUser: "Usuario reportante",
	sessionEmail: "Email de sesión",
	credit: "Crédito público",
} as const;

/** Lo que hace falta leer de un ticket para anonimizarlo (proyección de la consulta). */
export interface TicketAnonymizeDoc {
	id: string;
	title?: string;
	description?: unknown;
	customFields?: Record<string, unknown>;
	updateLog?: UpdateLogEntry[];
}

/**
 * Campos cuyo valor viejo queda fotografiado entero en el historial: `description` y `title` son el
 * cuerpo del ticket y `customFields`, el blob con los datos de contacto y la copia original. Sin
 * redactarlos, anonimizar el documento deja el dato accesible en `GET /issues/:id/history`.
 */
const LOGGED_SNAPSHOT_FIELDS: ReadonlySet<string> = new Set(["title", "description", "customFields"]);

/**
 * Historial con los snapshots sensibles reemplazados por el texto de retención, conservando quién,
 * cuándo y qué campo tocó (el rastro de la gestión no es el dato personal). `null` si no había nada
 * que redactar, para no reescribir el arreglo al pedo.
 */
function redactLogSnapshots(log: UpdateLogEntry[] | undefined): UpdateLogEntry[] | null {
	if (!Array.isArray(log) || log.length === 0) return null;
	let redacted = false;
	const entries = log.map((entry) => {
		if (!LOGGED_SNAPSHOT_FIELDS.has(entry.field) || (entry.oldValue == null && entry.newValue == null)) return entry;
		redacted = true;
		return { ...entry, oldValue: RETENTION_SCRUBBED_BODY, newValue: RETENTION_SCRUBBED_BODY };
	});
	return redacted ? entries : null;
}

/**
 * Patch de anonimización de UN ticket, compartido por la cascada de baja de cuenta y el barrido de
 * retención. Es una sola implementación a propósito: dos harían que un dato nuevo se borrara por
 * un camino y sobreviviera por el otro.
 *
 * `scrubBody` (hoy sólo `minor`) además vacía el texto libre y el título, que es donde vive el dato
 * sensible; las etiquetas se conservan para que el ticket siga siendo triable.
 *
 * `keepPublicCredit` lo pasa **sólo el barrido de retención**: un agradecimiento público que la
 * persona pidió no caduca a los N días, y retirarlo por reloj sería revocarle un consentimiento
 * vigente sin que nadie lo pida — para eso está el flujo de revocación. En la cascada de baja, en
 * cambio, el handle sí se va: ahí la persona pidió que se borren sus datos. Por eso el crédito que
 * se conserva deja anotado su `creditOwnerUserId`: es lo que le permite a esa cascada encontrarlo.
 */
export function buildTicketAnonymizePatch(
	doc: TicketAnonymizeDoc,
	opts: { scrubBody?: boolean; keepPublicCredit?: boolean } = {}
): Record<string, unknown> {
	const cf = doc.customFields ?? {};
	const publiclyCredited = cf.publicDisclosure === "true" && cf.wantsCredit === "true";
	const keepCredit = opts.keepPublicCredit === true && publiclyCredited;
	const patch: Record<string, unknown> = {
		reporterId: "",
		updatedAt: new Date(),
		"customFields.reporterEmail": null,
		"customFields.reportedByEmail": null,
		"customFields.reportedByUserId": null,
	};
	if (keepCredit) {
		// El handle sobrevive al reloj de retención, pero la baja de cuenta tiene que poder retirarlo
		// (lo promete SECURITY.md): se conserva el único vínculo por el que `anonymizeReporter` puede
		// volver a encontrar el ticket, ya que `reportedByUserId` se borra igual.
		const owner = cf.creditOwnerUserId ?? cf.reportedByUserId;
		if (typeof owner === "string" && owner) patch["customFields.creditOwnerUserId"] = owner;
	} else {
		patch["customFields.creditName"] = null;
		patch["customFields.creditRevocationHash"] = null;
		patch["customFields.creditOwnerUserId"] = null;
	}

	// La copia canónica respalda el `descriptionHash` ya publicado: borrarla en una entrada
	// divulgada dejaría en el log de transparencia un hash que nadie puede verificar.
	if (cf.publicDisclosure !== "true") patch["customFields.originalDescription"] = null;

	if (opts.scrubBody) {
		patch.description = [{ type: "paragraph", text: RETENTION_SCRUBBED_BODY }] satisfies Block[];
		const prefix = /^\[[^\]]*\]\s*/.exec(doc.title ?? "")?.[0] ?? "";
		patch.title = `${prefix}${RETENTION_SCRUBBED_BODY}`;
		// Copia literal del título que escribió quien reportó: dejarla intacta devolvía por la API el
		// mismo dato que este patch dice borrar.
		patch["customFields.ticketTitle"] = null;
	} else if (Array.isArray(doc.description)) {
		patch.description = redactLabeledParagraphs(doc.description as Block[], REPORTER_LABELS);
	}

	const updateLog = redactLogSnapshots(doc.updateLog);
	if (updateLog) patch.updateLog = updateLog;

	return patch;
}

/** Acuse de recibo comprometido para requerimientos de autoridades (el mismo que publica la ayuda). */
const AUTHORITY_ACK_BUSINESS_DAYS = 5;

/** Suma `n` días hábiles (lun-vie) a una fecha. */
function addBusinessDays(from: Date, n: number): Date {
	const d = new Date(from);
	let added = 0;
	while (added < n) {
		d.setUTCDate(d.getUTCDate() + 1);
		const day = d.getUTCDay();
		if (day !== 0 && day !== 6) added++;
	}
	return d;
}

/**
 * Texto plano de una descripción por bloques, para la cola de moderación: sólo los bloques con
 * texto, que es lo que hace falta para leer el motivo y el enlace reportado.
 */
function plainTextFromBlocks(description: unknown): string {
	if (!Array.isArray(description)) return "";
	return (description as Block[])
		.map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
		.filter(Boolean)
		.join("\n");
}

function supportTicketCustomFields(
	input: CreateSupportTicketInput,
	caller: SupportTicketCaller,
	creditToken: string | null = null
): Record<string, CustomFieldValue> {
	const base: Record<string, CustomFieldValue> = {
		type: "support_ticket",
		ticketType: input.type,
		ticketTitle: input.title,
		reporterEmail: input.email,
		reportedByUserId: caller.userId,
		reportedByEmail: caller.email ?? null,
	};

	// ── Autoridades: fecha de entrada + acuse comprometido, y campos de triage vacíos ──
	// (los completa el endpoint de decisión, no quien envía el requerimiento).
	if (input.type === "authority") {
		const now = new Date();
		return {
			...base,
			authority: "true",
			reportedAt: now.toISOString(),
			authorityAckDueAt: addBusinessDays(now, AUTHORITY_ACK_BUSINESS_DAYS).toISOString(),
			authorityJurisdiction: null,
			authorityBody: null,
			authorityCaseFile: null,
			authorityRequestType: null,
			authorityDecision: "pending",
		};
	}

	// ── Bug bounty: campos estructurados para triage, SLA y transparencia ──
	// (customFields solo admite string|number|Date|string[]|null, así que los
	//  flags booleanos se codifican como "true"/"false").
	if (input.type === "security") {
		const now = new Date();
		return {
			...base,
			bugBounty: "true",
			// Hash público de la descripción original (log de transparencia).
			descriptionHash: sha256Hex(input.description),
			// Copia canónica que se revela al resolver (si hay crédito); debe matchear el hash.
			originalDescription: input.description,
			reportedAt: now.toISOString(),
			// SLA: acuse +7 días hábiles, ETA inicial +30 días hábiles.
			slaAckDueAt: addBusinessDays(now, 7).toISOString(),
			slaEtaDueAt: addBusinessDays(now, 30).toISOString(),
			// Triage / recompensa (los completa el admin).
			severity: null,
			rewardPreference: input.rewardPreference ?? null,
			rewardGranted: null,
			// Crédito / disclosure. Del código de revocación se guarda sólo el hash: el original
			// se le muestra una vez a quien reportó y la plataforma no puede reconstruirlo.
			wantsCredit: input.wantsCredit === true ? "true" : "false",
			creditName: input.wantsCredit ? (input.creditName ?? null) : null,
			creditRevocationHash: creditToken ? sha256Hex(creditToken) : null,
			publicDisclosure: "false",
			addedToAcknowledgments: "false",
			// Se completa sólo si el triage lo cierra como duplicado (columna "Duplicado").
			duplicateOf: null,
		};
	}

	return base;
}

function supportTicketBlocks(input: CreateSupportTicketInput, caller: SupportTicketCaller): Block[] {
	const blocks: Block[] = [
		{ type: "heading", level: 3, text: `Ticket de ${TICKET_TYPE_LABELS[input.type].toLowerCase()}` },
		{ type: "paragraph", text: `Tipo: ${TICKET_TYPE_LABELS[input.type]}` },
		{ type: "paragraph", text: `${REPORTER_LABELS.contactEmail}: ${input.email}` },
		{ type: "heading", level: 3, text: "Descripción" },
		{ type: "paragraph", text: input.description },
	];

	blocks.push(
		{ type: "heading", level: 3, text: "Información del reporte" },
		{ type: "paragraph", text: `${REPORTER_LABELS.reporterUser}: ${caller.userId ?? "Anónimo (sin sesión)"}` },
		{ type: "paragraph", text: `${REPORTER_LABELS.sessionEmail}: ${caller.email || "Anónimo"}` }
	);

	// Recordatorio interno (solo admin) para tickets de seguridad / bug bounty.
	if (input.type === "security") {
		const wantsCredit = input.wantsCredit === true;
		const creditName = wantsCredit ? `SÍ (handle: ${input.creditName || "sin especificar"})` : "no";
		blocks.push(
			{ type: "heading", level: 3, text: "Bug bounty — pasos internos (no público)" },
			{ type: "paragraph", text: `${REPORTER_LABELS.credit}: ${creditName}` },
			{ type: "paragraph", text: `Preferencia de recompensa: ${input.rewardPreference ?? "sin preferencia"}.` },
			{ type: "paragraph", text: "1) Triage: reproducir y asignar severidad (low/medium/high/critical) en customFields.severity." },
			{ type: "paragraph", text: "2) SLA: acusar recibo (slaAckDueAt) y dar ETA (slaEtaDueAt)." },
			{ type: "paragraph", text: "3) Fix + tests + versión parche; mover la tarjeta a la columna de estado correspondiente." },
			{
				type: "paragraph",
				text: 'Si el hallazgo ya estaba reportado: mover a la columna "Duplicado" (NO a "Descartado") y escribir la clave del ticket original en customFields.duplicateOf (ej. STATUS-42). El log público muestra "Duplicado de STATUS-42" — que es válido pero segundo — en vez de confundirlo con un reporte inválido. En duplicados se reconoce al primero.',
			},
			{
				type: "paragraph",
				text: "4) Recompensa: otorgar upgrade temporal de tier (plus/pro) según severidad y preferencia, vía endpoint de grants de Identity (reportedByUserId). Registrar en customFields.rewardGranted.",
			},
			{
				type: "paragraph",
				text: '5) Disclosure: recién con el ticket resuelto y el OK del reporter, marcar customFields.publicDisclosure="true" para publicar la descripción en el log de transparencia (/status/bounty, debe coincidir con descriptionHash). El handle sale sólo si además wantsCredit="true"; registrar addedToAcknowledgments.',
			},
			{
				type: "paragraph",
				text: 'Revocación de crédito: quien reportó puede retirarlo solo con el código que se le mostró al enviar. Si lo perdió y lo pide por otro canal, poner customFields.wantsCredit="false" y vaciar creditName a mano — no borrar la tarjeta ni descriptionHash: el hallazgo sigue publicado, sólo deja de estar firmado.',
			}
		);
	}

	if (input.type === "authority") blocks.push(...authorityRunbookBlocks());

	return blocks;
}

/**
 * Runbook interno de un requerimiento de autoridad (no público). Va en el cuerpo del ticket y no en
 * la documentación porque el paso que más se saltea es el primero, y sólo se saltea si no está a la
 * vista de quien abre la tarjeta.
 */
function authorityRunbookBlocks(): Block[] {
	return [
		{ type: "heading", level: 3, text: "Autoridades — pasos internos (no público)" },
		{
			type: "paragraph",
			text: "1) Autenticar al emisor por un canal INDEPENDIENTE del propio oficio: buscar el teléfono o la casilla institucional del organismo por su sitio oficial y llamar/escribir ahí. Nunca a los datos de contacto que trae el documento — un oficio falsificado también trae su propio número.",
		},
		{
			type: "paragraph",
			text: "2) Competencia: verificar que el organismo tenga jurisdicción sobre los datos pedidos. Autoridad extranjera ⇒ se responde por exhorto/MLAT, no por pedido directo; la única excepción es la PRESERVACIÓN (congelar sin entregar), que se puede atender mientras llega el instrumento.",
		},
		{
			type: "paragraph",
			text: "3) Necesidad y proporcionalidad: el pedido tiene que estar acotado a una cuenta/URL y a un rango temporal. Un 'todo lo que tengan de esta persona' se devuelve para acotar (decisión narrowed), por escrito y citando la norma que exige la fundamentación.",
		},
		{
			type: "paragraph",
			text: "4) Decidir y registrar por el endpoint de decisión (POST /api/pm/support-tickets/:ticketKey/authority-decision): deja la entrada en el audit log, que es el registro que hay que poder mostrar. No alcanza con mover la tarjeta.",
		},
		{
			type: "paragraph",
			text: "5) Notificar al titular de los datos, salvo prohibición legal. Si la hay, registrar la norma y el plazo en el ticket y marcar noticeDeferred: la notificación se difiere, no se cancela — hay que reagendarla para cuando venza.",
		},
		{
			type: "paragraph",
			text: "6) Cerrar moviendo la tarjeta a Resuelto. El ticket queda sin plazo de purga (es la constancia de la entrega); a los 365 días se le borran los datos de contacto de quien lo envió.",
		},
	];
}
